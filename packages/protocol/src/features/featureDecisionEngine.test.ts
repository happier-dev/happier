import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '../features.js';
import type { FeatureDecision } from './decision.js';
import {
  applyFeatureDependencies,
  evaluateFeatureDecisionBase,
  evaluateServerFeatureDecisions,
  listFeatureDependents,
} from './featureDecisionEngine.js';
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
    expect(out.blockingDependencyId).toBe('execution.runs');
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
    // The typed blocker names the dependency that decided the state, not the first unknown one.
    expect(out.blockingDependencyId).toBe('execution.runs');
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
    expect(out.blockingDependencyId).toBe('execution.runs');
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
    expect(out.blockingDependencyId).toBeUndefined();
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

  it('explains every server bit with a typed blocker: Home switch off, dependency, build policy', () => {
    const response = FeaturesResponseSchema.parse({
      features: {
        automations: { enabled: false },
        workflows: { enabled: true },
        localServices: {
          enabled: true,
          inventory: { enabled: true },
          launcher: { enabled: true },
        },
      },
      capabilities: {},
    });

    const decisions = evaluateServerFeatureDecisions({
      serverPayload: response,
      buildPolicy: (featureId) => (featureId === 'localServices.inventory' ? 'deny' : 'neutral'),
    });

    expect(decisions.get('automations')).toMatchObject({ state: 'disabled', blockedBy: 'server' });
    expect(decisions.get('automations')?.blockingDependencyId).toBeUndefined();
    expect(decisions.get('workflows')).toMatchObject({
      state: 'disabled',
      blockedBy: 'dependency',
      blockerCode: 'dependency_disabled',
      blockingDependencyId: 'automations',
    });
    expect(decisions.get('localServices.inventory')).toMatchObject({ state: 'disabled', blockedBy: 'build_policy' });
    expect(decisions.get('localServices')).toMatchObject({ state: 'enabled', blockedBy: null });
    // Evaluation never mutates the payload it explains.
    expect(readServerEnabledBit(response, 'workflows')).toBe(true);
    // Client-represented ids are not server decisions.
    expect(decisions.has('execution.runs')).toBe(false);
  });

  it('closes the payload exactly as the decisions explain it', () => {
    const payload = () => FeaturesResponseSchema.parse({
      features: {
        automations: { enabled: false },
        workflows: { enabled: true },
        teams: {
          enabled: false,
          credentialResources: { enabled: true, externalApi: { enabled: true } },
        },
      },
      capabilities: {},
    });
    const explained = evaluateServerFeatureDecisions({ serverPayload: payload() });
    const closed = payload();
    applyFeatureDependencies({ serverPayload: closed });

    for (const [featureId, decision] of explained) {
      expect({ featureId, enabled: readServerEnabledBit(closed, featureId) === true })
        .toEqual({ featureId, enabled: decision.state === 'enabled' });
    }
    // The transitive dependent names its immediate blocker.
    expect(explained.get('teams.credentialResources.externalApi')?.blockingDependencyId).toBe('teams.credentialResources');
  });

  it('selects one server decision with the same dependency policy without evaluating unrelated features', () => {
    const response = FeaturesResponseSchema.parse({
      features: { automations: { enabled: false }, workflows: { enabled: true } },
      capabilities: {},
    });
    const all = evaluateServerFeatureDecisions({ serverPayload: response });
    const selected = evaluateServerFeatureDecisions({
      serverPayload: { features: response.features },
      featureIds: ['workflows'],
      buildPolicy: (featureId) => {
        if (featureId !== 'workflows' && featureId !== 'automations') {
          throw new Error(`Unrelated policy evaluated: ${featureId}`);
        }
        return 'neutral';
      },
    });

    expect([...selected.keys()]).toEqual(['workflows']);
    expect(selected.get('workflows')).toEqual(all.get('workflows'));
    expect(selected.get('workflows')).toMatchObject({
      state: 'disabled', blockingDependencyId: 'automations',
    });
    expect(evaluateServerFeatureDecisions({
      serverPayload: { features: response.features }, featureIds: ['sessions.direct'],
    }).size).toBe(0);
  });

  it('lists the transitive dependents a parent takes with it', () => {
    expect(listFeatureDependents('automations')).toContain('workflows');
    const teamsDependents = listFeatureDependents('teams');
    expect(teamsDependents).toEqual(expect.arrayContaining(['teams.credentialResources', 'teams.credentialResources.externalApi']));
    expect(teamsDependents).not.toContain('teams');
  });
});
