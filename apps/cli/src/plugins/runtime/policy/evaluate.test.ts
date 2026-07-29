import { describe, expect, it } from 'vitest';

import {
  evaluateContributionAvailability,
  evaluateTargetActionPolicy,
  resolveTargetActionResourceSelectionFacts,
  targetActionRequiresCurrentIntent,
} from './evaluate';

const action = {
  qualifiedId: 'acme.alpha/actions/run',
  generation: '7',
  dangerLevel: 'safe',
  scopes: ['global'],
  surfaces: ['cli'],
  hostAccess: [],
} as const;

function authorizationFacts(overrides: Readonly<{
  reviewedPackageIdentity?: string | null;
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
}> = {}) {
  return {
    packageTrust: {
      packageIdentity: action.qualifiedId,
      reviewedPackageIdentity: overrides.reviewedPackageIdentity === undefined
        ? action.qualifiedId
        : overrides.reviewedPackageIdentity,
    },
    generation: {
      targetGeneration: action.generation,
      desiredGeneration: overrides.desiredGeneration === undefined
        ? action.generation
        : overrides.desiredGeneration,
      appliedGeneration: overrides.appliedGeneration === undefined
        ? action.generation
        : overrides.appliedGeneration,
    },
    resourceSelections: [],
    scopedGrants: [],
    operatingSystemAuthorization: [],
  } as const;
}

describe('evaluateTargetActionPolicy', () => {
  it.each([
    ['safe', false],
    ['writesLocal', true],
    ['writesRemote', true],
    ['externalSideEffect', true],
    ['destructive', true],
  ] as const)('maps the canonical %s danger level to current-intent requirement %s', (dangerLevel, expected) => {
    expect(targetActionRequiresCurrentIntent({ dangerLevel })).toBe(expected);
  });

  it.each([
    [{ ...action }, 'visible'],
    [{ ...action, surfaces: ['agent'] }, 'unavailable'],
    [{ ...action, scopes: ['session'] }, 'unavailable'],
    [{ ...action, availability: { status: 'disabled', code: 'feature_disabled' } }, 'disabled'],
    [{ ...action, hostAccess: [{ id: 'api', required: true, status: 'denied', requestFingerprint: 'api-scope' }] }, 'denied'],
    [{ ...action, hostAccess: [{ id: 'cache', required: false, status: 'unavailable', requestFingerprint: 'cache-scope' }] }, 'unavailable'],
  ] as const)('normalizes packed policy case %# to %s', (candidate, outcome) => {
    expect(evaluateTargetActionPolicy({
      action: candidate,
      authorizationFacts: authorizationFacts(),
      surface: 'cli',
    }).outcome).toBe(outcome);
  });

  it('fails closed for stale generations and unresolved dynamic policy', () => {
    expect(evaluateTargetActionPolicy({
      action,
      authorizationFacts: authorizationFacts({ desiredGeneration: '8', appliedGeneration: '8' }),
      surface: 'cli',
    })).toMatchObject({
      outcome: 'unavailable', code: 'plugin_action_generation_retired',
    });
    expect(evaluateTargetActionPolicy({
      action: { ...action, availability: { status: 'unavailable', code: 'dynamic_context_missing' } },
      authorizationFacts: authorizationFacts(), surface: 'cli',
    })).toMatchObject({ outcome: 'unavailable', code: 'dynamic_context_missing' });
  });

  it('distinguishes reviewed package trust from desired and applied currentness', () => {
    expect(evaluateTargetActionPolicy({
      action,
      authorizationFacts: authorizationFacts({ reviewedPackageIdentity: 'acme.other@1' }),
      surface: 'cli',
    })).toMatchObject({ outcome: 'denied', code: 'plugin_action_package_untrusted' });

    expect(evaluateTargetActionPolicy({
      action,
      authorizationFacts: authorizationFacts({ appliedGeneration: '6' }),
      surface: 'cli',
    })).toMatchObject({ outcome: 'unavailable', code: 'plugin_action_generation_not_applied' });
  });

  it('fails closed when an optional host-resource decision omits its selected-resource facts', () => {
    const candidate = {
      ...action,
      hostAccess: [{
        id: 'review-target',
        required: false,
        status: 'available' as const,
        requestFingerprint: 'review-target-scope',
      }],
    };
    const resourceSelections = resolveTargetActionResourceSelectionFacts(candidate);

    expect(resourceSelections).toEqual([{
      id: 'review-target',
      required: true,
      requestedResourceId: 'review-target-scope',
    }]);
    expect(evaluateTargetActionPolicy({
      action: candidate,
      authorizationFacts: {
        ...authorizationFacts(),
        resourceSelections,
      },
      surface: 'cli',
    })).toMatchObject({
      outcome: 'denied',
      code: 'plugin_action_resource_not_selected',
    });
  });
});

describe('evaluateContributionAvailability', () => {
  it('evaluates known facts and fails closed when a required fact is unavailable', () => {
    const availability = {
      when: { fact: 'plugin.enabled' as const, operator: 'equals' as const, value: true },
      disabledWhen: { fact: 'session.state' as const, operator: 'equals' as const, value: 'blocked' },
      disabledReason: 'Blocked session',
    };

    expect(evaluateContributionAvailability({
      availability,
      facts: { 'plugin.enabled': true, 'session.state': 'ready' },
    })).toEqual({ outcome: 'visible', code: 'plugin_contribution_available' });
    expect(evaluateContributionAvailability({
      availability,
      facts: { 'plugin.enabled': true, 'session.state': 'blocked' },
    })).toEqual({ outcome: 'disabled', code: 'plugin_contribution_disabled' });
    expect(evaluateContributionAvailability({
      availability,
      facts: { 'plugin.enabled': true },
    })).toEqual({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
  });
});
