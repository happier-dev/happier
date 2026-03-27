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

  it('loads the production embedded policy (may be neutral)', () => {
    const policy = resolveEmbeddedFeatureBuildPolicy('production');
    expect(policy.allow).toEqual(expect.any(Array));
    expect(policy.deny).toEqual(expect.any(Array));
    expect(evaluateFeatureBuildPolicy(policy, 'updates.ota')).toBe('neutral');
  });

  it('does not ship-deny attachments uploads in the production embedded policy', () => {
    const policy = resolveEmbeddedFeatureBuildPolicy('production');
    expect(evaluateFeatureBuildPolicy(policy, 'attachments.uploads')).toBe('neutral');
  });

  it('merges env policy by union and preserves deny precedence', () => {
    const base = resolveEmbeddedFeatureBuildPolicy('production');
    const merged = mergeFeatureBuildPolicies(base, { allow: ['voice'], deny: ['voice'] });
    expect(evaluateFeatureBuildPolicy(merged, 'voice')).toBe('deny');
  });
});
