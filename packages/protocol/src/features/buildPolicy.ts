import type { FeatureId } from './featureIds.js';
import { isFeatureId } from './featureIds.js';
import { getCanonicalFeatureId } from './catalog.js';

export type FeatureBuildPolicy = Readonly<{
  allow: readonly FeatureId[];
  deny: readonly FeatureId[];
}>;

export type FeatureBuildPolicyEvaluation = 'allow' | 'deny' | 'neutral';

function splitIds(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeIds(raw: string | null | undefined): FeatureId[] {
  if (typeof raw !== 'string') return [];
  const out: FeatureId[] = [];
  const seen = new Set<FeatureId>();
  for (const candidate of splitIds(raw)) {
    if (!isFeatureId(candidate)) continue;
    const featureId = getCanonicalFeatureId(candidate);
    if (seen.has(featureId)) continue;
    seen.add(featureId);
    out.push(featureId);
  }
  return out;
}

export function parseFeatureBuildPolicy(input: {
  allowRaw?: string | null;
  denyRaw?: string | null;
}): FeatureBuildPolicy {
  return {
    allow: normalizeIds(input.allowRaw),
    deny: normalizeIds(input.denyRaw),
  };
}

export function evaluateFeatureBuildPolicy(policy: FeatureBuildPolicy, featureId: FeatureId): FeatureBuildPolicyEvaluation {
  featureId = getCanonicalFeatureId(featureId);
  if (policy.deny.includes(featureId)) return 'deny';
  if (policy.allow.includes(featureId)) return 'allow';
  if (policy.allow.length > 0) return 'deny';
  return 'neutral';
}
