import { describe, expect, it } from 'vitest';

import type { FeatureDecision } from './decision.js';
import { applyFeatureDependencies, evaluateFeatureDecisionBase } from './featureDecisionEngine.js';

function enabled(featureId: any): FeatureDecision {
  return {
    featureId,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
  };
}

describe('feature decision engine', () => {
  it('disables voice.agent when execution.runs dependency is disabled', () => {
    const base = enabled('voice.agent');
    const out = applyFeatureDependencies({
      featureId: 'voice.agent',
      baseDecision: base,
      resolveDependencyDecision: (dep) => {
        if (dep === 'voice') return enabled('voice');
        if (dep === 'execution.runs') {
          return {
            ...enabled('execution.runs'),
            state: 'disabled',
            blockedBy: 'local_policy',
            blockerCode: 'flag_disabled',
          };
        }
        return enabled(dep);
      },
    });

    expect(out.state).toBe('disabled');
    expect(out.blockedBy).toBe('dependency');
    expect(out.blockerCode).toBe('dependency_disabled');
  });

  it('prefers disabled when any dependency is disabled even if another dependency is unknown', () => {
    const base = enabled('voice.agent');
    const out = applyFeatureDependencies({
      featureId: 'voice.agent',
      baseDecision: base,
      resolveDependencyDecision: (dep) => {
        if (dep === 'voice') {
          return {
            ...enabled('voice'),
            state: 'unknown',
            blockedBy: 'server',
            blockerCode: 'probe_failed',
          };
        }
        if (dep === 'execution.runs') {
          return {
            ...enabled('execution.runs'),
            state: 'disabled',
            blockedBy: 'local_policy',
            blockerCode: 'flag_disabled',
          };
        }
        return enabled(dep);
      },
    });

    expect(out.state).toBe('disabled');
    expect(out.blockedBy).toBe('dependency');
    expect(out.blockerCode).toBe('dependency_disabled');
  });

  it('returns unknown when a dependency is unknown', () => {
    const base = enabled('voice.agent');
    const out = applyFeatureDependencies({
      featureId: 'voice.agent',
      baseDecision: base,
      resolveDependencyDecision: (dep) => {
        if (dep === 'voice') return enabled('voice');
        if (dep === 'execution.runs') {
          return {
            ...enabled('execution.runs'),
            state: 'unknown',
            blockedBy: 'server',
            blockerCode: 'probe_failed',
          };
        }
        return enabled(dep);
      },
    });

    expect(out.state).toBe('unknown');
    expect(out.blockedBy).toBe('dependency');
    expect(out.blockerCode).toBe('dependency_unknown');
  });

  it('keeps base decision when feature is already disabled', () => {
    const base = evaluateFeatureDecisionBase({
      featureId: 'voice.agent',
      scope: { scopeKind: 'runtime' },
      supportsClient: true,
      buildPolicy: 'neutral',
      localPolicyEnabled: false,
      serverSupported: true,
      serverEnabled: true,
      evaluatedAt: 1,
    });

    const out = applyFeatureDependencies({
      featureId: 'voice.agent',
      baseDecision: base,
      resolveDependencyDecision: () => enabled('voice'),
    });

    expect(out.state).toBe('disabled');
    expect(out.blockedBy).toBe('local_policy');
  });
});
