import { describe, expect, it } from 'vitest';

import { FeatureDecisionSchema, createFeatureDecision } from './decision.js';

describe('feature decision', () => {
  it('creates a valid decision payload', () => {
    const decision = createFeatureDecision({
      featureId: 'automations',
      state: 'disabled',
      blockedBy: 'local_policy',
      blockerCode: 'flag_disabled',
      diagnostics: ['settings.experiments=false'],
      scope: { scopeKind: 'runtime', serverId: 'dev' },
      evaluatedAt: 123,
    });

    const parsed = FeatureDecisionSchema.parse(decision);
    expect(parsed.featureId).toBe('automations');
    expect(parsed.blockedBy).toBe('local_policy');
    expect(parsed.blockerCode).toBe('flag_disabled');
  });

  it('rejects blocker mismatches for enabled state', () => {
    expect(() =>
      FeatureDecisionSchema.parse({
        featureId: 'voice',
        state: 'enabled',
        blockedBy: 'server',
        blockerCode: 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
      }),
    ).toThrow(/enabled/i);
  });
});
