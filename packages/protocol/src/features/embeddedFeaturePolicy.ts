import type { FeatureBuildPolicy } from './buildPolicy.js';
import { parseFeatureBuildPolicy } from './buildPolicy.js';

import {
  EMBEDDED_FEATURE_BUILD_POLICY_RAW,
} from './embeddedFeaturePolicies.generated.js';

export type EmbeddedFeaturePolicyEnv = 'preview' | 'production';

export function resolveEmbeddedFeaturePolicyEnv(value: unknown): EmbeddedFeaturePolicyEnv | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'production' || normalized === 'prod' || normalized === 'stable') return 'production';
  if (normalized === 'preview') return 'preview';
  return null;
}

export function resolveEmbeddedFeatureBuildPolicy(
  envName?: EmbeddedFeaturePolicyEnv | null,
): FeatureBuildPolicy {
  if (!envName) {
    return { allow: [], deny: [] };
  }

  const raw = EMBEDDED_FEATURE_BUILD_POLICY_RAW[envName];
  return parseFeatureBuildPolicy(raw);
}

export function mergeFeatureBuildPolicies(base: FeatureBuildPolicy, override: FeatureBuildPolicy): FeatureBuildPolicy {
  return {
    allow: [...new Set<FeatureBuildPolicy['allow'][number]>([...base.allow, ...override.allow])],
    deny: [...new Set<FeatureBuildPolicy['deny'][number]>([...base.deny, ...override.deny])],
  };
}

export function resolveFeatureBuildPolicyFromEnvOrEmbedded(input: Readonly<{
  embeddedEnv?: EmbeddedFeaturePolicyEnv;
  allowRaw?: string | null;
  denyRaw?: string | null;
}>): FeatureBuildPolicy {
  const embedded = resolveEmbeddedFeatureBuildPolicy(input.embeddedEnv);
  const override = parseFeatureBuildPolicy({
    allowRaw: input.allowRaw,
    denyRaw: input.denyRaw,
  });
  return mergeFeatureBuildPolicies(embedded, override);
}
