import {
    resolveEmbeddedFeaturePolicyEnv,
    resolveFeatureBuildPolicyFromEnvOrEmbedded,
    type FeatureBuildPolicy,
} from "@happier-dev/protocol";

type Cached = Readonly<{
    key: string;
    policy: FeatureBuildPolicy;
}>;

let cached: Cached | null = null;

function buildCacheKey(env: NodeJS.ProcessEnv): string {
    const embeddedEnv = resolveEmbeddedFeaturePolicyEnv(
      env.HAPPIER_FEATURE_POLICY_ENV ?? env.HAPPIER_EMBEDDED_POLICY_ENV,
    ) ?? "";
    const allow = String(env.HAPPIER_BUILD_FEATURES_ALLOW ?? "");
    const deny = String(env.HAPPIER_BUILD_FEATURES_DENY ?? "");
    return `${embeddedEnv}\n${allow}\n${deny}`;
}

export function resolveServerFeatureBuildPolicy(env: NodeJS.ProcessEnv): FeatureBuildPolicy {
    const key = buildCacheKey(env);
    if (cached?.key === key) return cached.policy;

    const policy = resolveFeatureBuildPolicyFromEnvOrEmbedded({
        embeddedEnv: resolveEmbeddedFeaturePolicyEnv(
          env.HAPPIER_FEATURE_POLICY_ENV ?? env.HAPPIER_EMBEDDED_POLICY_ENV,
        ) ?? undefined,
        allowRaw: env.HAPPIER_BUILD_FEATURES_ALLOW,
        denyRaw: env.HAPPIER_BUILD_FEATURES_DENY,
    });

    cached = { key, policy };
    return policy;
}
