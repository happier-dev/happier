import { describe, expect, it } from 'vitest';

import {
  evaluatePluginFinalPolicy,
  evaluatePluginActionPolicy,
  type PluginFinalPolicyInput,
  type PluginActionPolicyInput,
} from './policy.js';

const scope = Object.freeze({
  accountId: 'account-1',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  machineId: 'machine-1',
  actorId: 'user-1',
});

const allowed: PluginActionPolicyInput = Object.freeze({
  generation: Object.freeze({
    targetGeneration: 'generation-7',
    desiredGeneration: 'generation-7',
    appliedGeneration: 'generation-7',
  }),
  resourceSelections: Object.freeze([Object.freeze({
    id: 'connected-account',
    required: true,
    requestedResourceId: 'github-account-1',
    selectedResourceId: 'github-account-1',
  })]),
  scopedGrants: Object.freeze([Object.freeze({
    id: 'review-write',
    required: true,
    status: 'active',
    requiredScope: scope,
    grantedScope: scope,
  })]),
  serviceAvailability: Object.freeze([Object.freeze({
    id: 'reviews',
    required: true,
    status: 'available',
  })]),
  operatingSystemAuthorization: Object.freeze([Object.freeze({
    id: 'microphone',
    required: true,
    status: 'available',
  })]),
  availability: Object.freeze({ status: 'visible', code: 'plugin_action_available' }),
  confirmation: 'currentIntentRequired',
});

function withInput(overrides: Partial<PluginActionPolicyInput>): PluginActionPolicyInput {
  return Object.freeze({ ...allowed, ...overrides });
}

describe('evaluatePluginActionPolicy', () => {
  it('treats an exact admitted current generation as the package-trust fact', () => {
    expect(evaluatePluginActionPolicy(allowed)).toEqual({
      outcome: 'visible',
      code: 'plugin_action_available',
      requiresCurrentIntent: true,
    });
  });

  it('allows only the exact current, selected, granted, and available action facts', () => {
    expect(evaluatePluginActionPolicy(allowed)).toEqual({
      outcome: 'visible',
      code: 'plugin_action_available',
      requiresCurrentIntent: true,
    });
  });

  it.each([
    [
      'desired generation',
      withInput({ generation: { ...allowed.generation, desiredGeneration: 'generation-8' } }),
      { outcome: 'unavailable', code: 'plugin_action_generation_retired' },
    ],
    [
      'applied generation',
      withInput({ generation: { ...allowed.generation, appliedGeneration: 'generation-8' } }),
      { outcome: 'unavailable', code: 'plugin_action_generation_not_applied' },
    ],
    [
      'optional resource selection',
      withInput({ resourceSelections: [{ ...allowed.resourceSelections[0]!, selectedResourceId: 'github-account-2' }] }),
      { outcome: 'denied', code: 'plugin_action_resource_selection_mismatch' },
    ],
    [
      'scoped grant',
      withInput({ scopedGrants: [{ ...allowed.scopedGrants[0]!, grantedScope: { ...scope, projectId: 'project-2' } }] }),
      { outcome: 'denied', code: 'plugin_action_grant_scope_mismatch' },
    ],
    [
      'grant revocation',
      withInput({ scopedGrants: [{ ...allowed.scopedGrants[0]!, status: 'revoked' }] }),
      { outcome: 'denied', code: 'plugin_action_grant_revoked' },
    ],
    [
      'service availability',
      withInput({ serviceAvailability: [{ ...allowed.serviceAvailability[0]!, status: 'unavailable' }] }),
      { outcome: 'unavailable', code: 'plugin_action_service_unavailable' },
    ],
    [
      'operating-system authorization',
      withInput({ operatingSystemAuthorization: [{ ...allowed.operatingSystemAuthorization[0]!, status: 'denied' }] }),
      { outcome: 'denied', code: 'plugin_action_os_authorization_denied' },
    ],
    [
      'action availability',
      withInput({ availability: { status: 'disabled', code: 'feature_disabled' } }),
      { outcome: 'disabled', code: 'feature_disabled' },
    ],
  ] as const)('fails closed when %s changes', (_label, input, expected) => {
    expect(evaluatePluginActionPolicy(input)).toMatchObject(expected);
  });

  it('classifies confirmation independently from authorization', () => {
    expect(evaluatePluginActionPolicy(withInput({ confirmation: 'notRequired' }))).toEqual({
      outcome: 'visible',
      code: 'plugin_action_available',
      requiresCurrentIntent: false,
    });
  });

  it('does not turn a declared but inapplicable host service into an action gate', () => {
    expect(evaluatePluginActionPolicy(withInput({
      serviceAvailability: [{
        ...allowed.serviceAvailability[0]!,
        status: 'notApplicable',
        code: 'plugin_host_access_not_applicable',
      }],
    }))).toEqual({
      outcome: 'visible',
      code: 'plugin_action_available',
      requiresCurrentIntent: true,
    });
  });
});

describe('evaluatePluginFinalPolicy', () => {
  it('is the shared fail-closed decision for a non-action consumer', () => {
    const input: PluginFinalPolicyInput = Object.freeze({
      ...allowed,
      generation: Object.freeze({
        ...allowed.generation,
        appliedGeneration: 'generation-8',
      }),
      currentIntent: 'notRequired',
    });

    expect(evaluatePluginFinalPolicy(input)).toEqual({
      outcome: 'unavailable',
      code: 'plugin_final_generation_not_applied',
      requiresCurrentIntent: false,
    });
  });

  it('keeps a stable retained target available when durable H is desired but G remains applied', () => {
    const input: PluginFinalPolicyInput = Object.freeze({
      ...allowed,
      generation: Object.freeze({
        ...allowed.generation,
        desiredGeneration: 'generation-8',
        appliedGeneration: 'generation-7',
        targetGenerationMode: 'retained',
      }),
      currentIntent: 'notRequired',
    });

    expect(evaluatePluginFinalPolicy(input)).toEqual({
      outcome: 'visible',
      code: 'plugin_final_available',
      requiresCurrentIntent: false,
    });
  });
});
