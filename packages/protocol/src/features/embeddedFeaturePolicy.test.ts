import { describe, expect, it } from 'vitest';

import { evaluateFeatureBuildPolicy } from './buildPolicy.js';
import {
  mergeFeatureBuildPolicies,
  resolveEmbeddedFeatureBuildPolicy,
  resolveEmbeddedFeaturePolicyEnv,
} from './embeddedFeaturePolicy.js';

describe('embedded feature build policy', () => {
  it('does not treat development as preview', () => {
    expect(resolveEmbeddedFeaturePolicyEnv('development')).toBeNull();
    expect(resolveEmbeddedFeaturePolicyEnv('dev')).toBeNull();
  });

  it('defaults to neutral policy when no embedded policy env is configured', () => {
    const policy = resolveEmbeddedFeatureBuildPolicy(undefined);
    expect(policy.allow).toEqual([]);
    expect(policy.deny).toEqual([]);
  });

  it('loads the production embedded policy and marks known features allowed', () => {
    const policy = resolveEmbeddedFeatureBuildPolicy('production');
    expect(policy.allow.length).toBeGreaterThan(0);
    expect(evaluateFeatureBuildPolicy(policy, 'updates.ota')).toBe('allow');
  });

  it('allows attachments uploads in the production embedded policy', () => {
    const policy = resolveEmbeddedFeatureBuildPolicy('production');
    expect(evaluateFeatureBuildPolicy(policy, 'attachments.uploads')).toBe('allow');
  });

  it('merges env policy by union and preserves deny precedence', () => {
    const base = resolveEmbeddedFeatureBuildPolicy('production');
    const merged = mergeFeatureBuildPolicies(base, { allow: ['voice'], deny: ['voice'] });
    expect(evaluateFeatureBuildPolicy(merged, 'voice')).toBe('deny');
  });
});
