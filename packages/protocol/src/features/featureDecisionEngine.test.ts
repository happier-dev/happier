import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '../features.js';
import type { FeatureDecision } from './decision.js';
import { applyFeatureDependencies, evaluateFeatureDecisionBase } from './featureDecisionEngine.js';
import { readServerEnabledBit } from './serverEnabledBit.js';

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

  it('disables voice.daemonInference when voice.agent is disabled', () => {
    const base = enabled('voice.daemonInference');
    const out = applyFeatureDependencies({
      featureId: 'voice.daemonInference',
      baseDecision: base,
      resolveDependencyDecision: (dep) => {
        if (dep === 'voice.agent') {
          return {
            ...enabled('voice.agent'),
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

  it('applies server enabled-bit dependency pruning to a fixed point', () => {
    const response = FeaturesResponseSchema.parse({
      features: {
        localServices: {
          enabled: true,
          inventory: { enabled: true },
          managed: { enabled: true },
          preview: { enabled: true },
          launcher: { enabled: true },
        },
        browser: {
          enabled: false,
          viewTargets: { enabled: true },
        },
      },
      capabilities: {},
    });

    applyFeatureDependencies({ serverPayload: response });

    expect(readServerEnabledBit(response, 'browser')).toBe(false);
    expect(readServerEnabledBit(response, 'browser.viewTargets')).toBe(false);
    expect(readServerEnabledBit(response, 'localServices.launcher')).toBe(false);
    expect(readServerEnabledBit(response, 'localServices.inventory')).toBe(true);
  });
});
