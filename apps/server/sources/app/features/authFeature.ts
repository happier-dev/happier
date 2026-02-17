import type { FeaturesPayloadDelta, FeaturesResponse } from "./types";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { resolveAuthProviderRegistryResult } from "@/app/auth/providers/registry";
import { readAuthFeatureEnv } from "./catalog/readFeatureEnv";

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
    const policy = resolveAuthPolicyFromEnv(env);
    const authProviderRegistryResult = resolveAuthProviderRegistryResult(env);
    const authProviderRegistry = authProviderRegistryResult.providers;

    const signupProviders = uniqueStrings(policy.signupProviders);
    const requiredLoginProviders = uniqueStrings(policy.requiredLoginProviders);

    const signupMethods: Array<{ id: string; enabled: boolean }> = [
        { id: "anonymous", enabled: policy.anonymousSignupEnabled },
        ...signupProviders.map((id) => ({ id, enabled: true })),
    ];

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

    const providers: FeaturesResponse["capabilities"]["auth"]["providers"] = {};
    for (const provider of authProviderRegistry) {
        providers[provider.id] = provider.resolveFeatures({ env, policy });
    }

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
    if (autoRedirectEnabled && !policy.anonymousSignupEnabled) {
        const candidate =
            explicitAutoRedirectProviderId ||
            (enabledExternalSignupProviders.length === 1 ? enabledExternalSignupProviders[0] : "");

        if (candidate) {
            const resolver = authProviderRegistry.find((p) => p.id === candidate) ?? null;
            if (resolver && (!resolver.requiresOAuth || resolver.isConfigured(env))) {
                autoRedirectProviderId = resolver.id;
            }
        }
    }

    return {
        features: {
            auth: {
                recovery: {
                    providerReset: {
                        enabled: providerResetEnabled,
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
                signup: { methods: signupMethods },
                login: { requiredProviders: requiredLoginProviders },
                recovery: {
                    providerReset: {
                        providers: providerResetEnabled ? providerResetProviders : [],
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
