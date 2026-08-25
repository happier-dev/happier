import { describe, expect, it } from 'vitest';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import { createLoggerAvailablePluginInvocationServiceBinding } from '../invocation/services/factory';
import { createPluginInvocationHostPolicyResolver } from '../hostAccess/resolve';
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
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
}> = {}) {
  return {
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

  it('keeps a terminal-only declaration visible when the current invocation cannot host it', () => {
    expect(evaluateTargetActionPolicy({
      action: {
        ...action,
        hostAccess: [{
          id: 'terminal-control',
          required: true,
          status: 'notApplicable' as const,
          code: 'plugin_host_access_not_applicable',
          requestFingerprint: 'terminal-control-scope',
        }],
      },
      authorizationFacts: authorizationFacts(),
      surface: 'cli',
    })).toMatchObject({
      outcome: 'visible',
      code: 'plugin_action_available',
    });
  });

  /**
   * Table-driven execution gate over the REAL HostAccess resolver, so the two
   * halves of the decision cannot drift: `terminal` is genuinely outside an
   * ordinary invocation's topology and stays satisfiable, while the deferred
   * capabilities with no host authority must block execution instead of
   * silently reading as available.
   */
  it.each([
    {
      request: {
        id: 'terminal-access',
        capability: 'terminal',
        reason: 'Use declared terminal access',
        scope: { operations: ['open'] },
      },
      outcome: 'visible',
      code: 'plugin_action_available',
    },
    {
      request: {
        id: 'browser-access',
        capability: 'browser',
        reason: 'Use declared browser access',
        scope: { operations: ['navigate'] },
      },
      outcome: 'unavailable',
      code: 'plugin_host_access_service_unavailable',
    },
    {
      request: {
        id: 'clipboard-access',
        capability: 'clipboard',
        reason: 'Use declared clipboard access',
        scope: { access: ['read'] },
      },
      outcome: 'unavailable',
      code: 'plugin_host_access_service_unavailable',
    },
    {
      request: {
        id: 'externalLinks-access',
        capability: 'externalLinks',
        reason: 'Use declared externalLinks access',
        scope: { origins: ['https://example.com'] },
      },
      outcome: 'unavailable',
      code: 'plugin_host_access_service_unavailable',
    },
  ] satisfies readonly Readonly<{
    request: PluginHostAccessRequestV2;
    outcome: string;
    code: string;
  }>[])(
    'resolves required $request.capability HostAccess to a $outcome execution decision',
    ({ request, outcome, code }) => {
      const resolved = createPluginInvocationHostPolicyResolver({
        createServiceBinding: createLoggerAvailablePluginInvocationServiceBinding,
      })({
        qualifiedId: action.qualifiedId,
        pluginId: 'acme.alpha',
        generation: action.generation,
      }, {
        hostAccessRequests: [{ required: true, request }],
        surface: 'cli',
      });

      expect(evaluateTargetActionPolicy({
        action: { ...action, hostAccess: resolved.hostAccess },
        authorizationFacts: authorizationFacts(),
        surface: 'cli',
      })).toMatchObject({ outcome, code });
    },
  );

  it('distinguishes desired from applied currentness', () => {
    expect(evaluateTargetActionPolicy({
      action,
      authorizationFacts: authorizationFacts({ appliedGeneration: '6' }),
      surface: 'cli',
    })).toMatchObject({ outcome: 'unavailable', code: 'plugin_action_generation_not_applied' });
  });

  /**
   * UI-D26 — the stamped execution surface is the authorization input here, and
   * it is load-bearing in BOTH directions. The retired `?? 'agent'` default at
   * the daemon front door made a UI call evaluate as `agent`, which denied
   * `surfaces: ['ui']` actions and admitted agent-only ones.
   */
  it('admits a ui-only target action on the ui surface and denies it on agent', () => {
    const uiOnly = { ...action, surfaces: ['ui'] } as const;

    expect(evaluateTargetActionPolicy({
      action: uiOnly,
      authorizationFacts: authorizationFacts(),
      surface: 'ui',
    })).toMatchObject({ outcome: 'visible' });

    expect(evaluateTargetActionPolicy({
      action: uiOnly,
      authorizationFacts: authorizationFacts(),
      surface: 'agent',
    })).toMatchObject({
      outcome: 'unavailable',
      code: 'plugin_action_surface_unavailable',
    });
  });

  it('denies an agent-only target action stamped with the ui surface', () => {
    const agentOnly = { ...action, surfaces: ['agent'] } as const;

    expect(evaluateTargetActionPolicy({
      action: agentOnly,
      authorizationFacts: authorizationFacts(),
      surface: 'ui',
    })).toMatchObject({
      outcome: 'unavailable',
      code: 'plugin_action_surface_unavailable',
    });

    // Negative control: the same row IS admitted on its declared surface, so the
    // denial above cannot be an unconditional rejection.
    expect(evaluateTargetActionPolicy({
      action: agentOnly,
      authorizationFacts: authorizationFacts(),
      surface: 'agent',
    })).toMatchObject({ outcome: 'visible' });
  });

  it('distinguishes trusted background plugin dispatch from a human-triggered UI dispatch of the same plugin target', () => {
    const pluginTarget = {
      ...action,
      dangerLevel: 'writesRemote',
      surfaces: ['plugin'],
    } as const;

    expect(evaluateTargetActionPolicy({
      action: pluginTarget,
      authorizationFacts: authorizationFacts(),
      surface: 'plugin',
      invocationSurface: 'background',
    })).toMatchObject({
      outcome: 'visible',
      requiresCurrentIntent: false,
    });

    // The target's declared plugin surface permits the call, but it must not
    // grant the mounted UI gesture a background-current-intent exemption.
    expect(evaluateTargetActionPolicy({
      action: pluginTarget,
      authorizationFacts: authorizationFacts(),
      surface: 'plugin',
      invocationSurface: 'ui',
    })).toMatchObject({
      outcome: 'visible',
      requiresCurrentIntent: true,
    });
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
