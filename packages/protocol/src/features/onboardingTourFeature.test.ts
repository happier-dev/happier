import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '../features.js';
import { FEATURE_CATALOG, isFeatureId } from './catalog.js';
import { applyFeatureDependencies, evaluateFeatureDecisionBase } from './featureDecisionEngine.js';
import { readServerEnabledBit } from './serverEnabledBit.js';

describe('app.ui.onboardingTour feature gate', () => {
  it('declares the onboarding tour as a fail-closed client feature', () => {
    expect(isFeatureId('app.ui.onboardingTour')).toBe(true);
    expect(FEATURE_CATALOG['app.ui.onboardingTour']).toMatchObject({
      defaultFailMode: 'fail_closed',
      representation: 'client',
      dependencies: ['app.ui.sessionGettingStartedGuidance'],
    });
  });

  it('applies dependency decisions before enabling the tour', () => {
    const baseDecision = evaluateFeatureDecisionBase({
      featureId: 'app.ui.onboardingTour',
      scope: { scopeKind: 'runtime' },
      supportsClient: true,
      buildPolicy: 'allow',
      localPolicyEnabled: true,
      serverSupported: true,
      serverEnabled: true,
      evaluatedAt: 1,
    });

    const decision = applyFeatureDependencies({
      featureId: 'app.ui.onboardingTour',
      baseDecision,
      resolveDependencyDecision: (featureId) => ({
        featureId,
        state: 'disabled',
        blockedBy: 'local_policy',
        blockerCode: 'flag_disabled',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
      }),
    });

    expect(decision.state).toBe('disabled');
    expect(decision.blockedBy).toBe('dependency');
    expect(decision.blockerCode).toBe('dependency_disabled');
  });

  it('fails closed when no server payload bit exists for the client-only tour gate', () => {
    const parsed = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });

    expect(readServerEnabledBit(parsed, 'app.ui.onboardingTour')).toBe(null);
  });
});
