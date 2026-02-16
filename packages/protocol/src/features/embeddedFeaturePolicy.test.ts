import { describe, expect, it } from 'vitest';

import { evaluateFeatureBuildPolicy } from './buildPolicy.js';
import { mergeFeatureBuildPolicies, resolveEmbeddedFeatureBuildPolicy } from './embeddedFeaturePolicy.js';

describe('embedded feature build policy', () => {
  it('loads the production embedded policy and marks known features allowed', () => {
    const policy = resolveEmbeddedFeatureBuildPolicy('production');
    expect(policy.allow.length).toBeGreaterThan(0);
    expect(evaluateFeatureBuildPolicy(policy, 'automations')).toBe('allow');
  });

  it('merges env policy by union and preserves deny precedence', () => {
    const base = resolveEmbeddedFeatureBuildPolicy('production');
    const merged = mergeFeatureBuildPolicies(base, { allow: ['voice'], deny: ['voice'] });
    expect(evaluateFeatureBuildPolicy(merged, 'voice')).toBe('deny');
  });
});

