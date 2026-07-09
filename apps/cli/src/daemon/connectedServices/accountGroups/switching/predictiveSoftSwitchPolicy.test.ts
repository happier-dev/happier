import { describe, expect, it } from 'vitest';

import {
  evaluatePredictiveSoftSwitchLiveSessionRequirement,
  evaluatePredictiveSoftSwitchPolicy,
} from './predictiveSoftSwitchPolicy';

const VALID_CODEX_RUNTIME_AUTH_APPLY = {
  directLiveHotAuth: {
    supportsInTurnApply: true,
    requiresExactRuntimeIdentity: true,
    refreshSelectionResync: 'required',
    authMode: {
      kind: 'external_token_injection',
      surface: 'codex_chatgpt_auth_tokens',
    },
  },
} as const;

describe('evaluatePredictiveSoftSwitchPolicy', () => {
  it('suppresses predictive soft-threshold switching for restart-only providers', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'unsupported',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    });
  });

  it('suppresses predictive soft-threshold switching while a turn is in flight', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });

  it('allows predictive soft-threshold switching during a turn with valid direct-live runtime apply capability', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
      runtimeAuthApply: VALID_CODEX_RUNTIME_AUTH_APPLY,
    })).toEqual({ status: 'allow' });
  });

  it('does not allow in-turn switching for a partial direct-live runtime apply capability', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
      runtimeAuthApply: {
        directLiveHotAuth: { supportsInTurnApply: true },
      } as unknown as typeof VALID_CODEX_RUNTIME_AUTH_APPLY,
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });

  it('keeps hard usage-limit switching enabled even when predictive soft switching is disabled', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'usage_limit',
      predictiveSoftSwitchMode: 'unsupported',
      turnState: { inFlight: true },
    })).toEqual({ status: 'allow' });
  });

  it('also requires hot apply for live same-provider-account exhaustion fanout', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'same_provider_account_exhausted',
      predictiveSoftSwitchMode: 'unsupported',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    });
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'same_provider_account_exhausted',
      predictiveSoftSwitchMode: 'supported',
    })).toEqual({ status: 'allow' });
  });

  it('defers proven same-provider-account exhaustion fanout while a sibling turn is in flight', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'same_provider_account_exhausted',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
    })).toEqual({
      status: 'defer',
      reason: 'predictive_soft_switch_defer_until_turn_boundary',
    });
  });

  it('allows same-provider-account exhaustion fanout during a turn with valid direct-live runtime apply capability', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'same_provider_account_exhausted',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
      runtimeAuthApply: VALID_CODEX_RUNTIME_AUTH_APPLY,
    })).toEqual({ status: 'allow' });
  });
});

describe('evaluatePredictiveSoftSwitchLiveSessionRequirement', () => {
  const requirement = {
    kind: 'shared_group_auth_surface' as const,
    serviceIds: ['claude-subscription'] as const,
    authEnvKey: 'CLAUDE_CONFIG_DIR',
    authEnvSubpath: ['claude-config'] as const,
  };

  it('allows Claude live predictive switching only on the shared group auth surface', () => {
    const activeServerDir = '/tmp/happier-server';
    const sharedConfigDir = [
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'main',
      'claude',
      'claude-config',
    ].join('/');

    expect(evaluatePredictiveSoftSwitchLiveSessionRequirement({
      reason: 'soft_threshold',
      requirement,
      activeServerDir,
      agentId: 'claude',
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'primary',
      env: {
        CLAUDE_CONFIG_DIR: sharedConfigDir,
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
          {
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'main',
            activeProfileId: 'primary',
            fallbackProfileId: 'primary',
            generation: 7,
          },
        ]),
      },
    })).toEqual({ status: 'allow' });
  });

  it('suppresses Claude live predictive switching when the shared auth surface is unproven', () => {
    expect(evaluatePredictiveSoftSwitchLiveSessionRequirement({
      reason: 'soft_threshold',
      requirement,
      activeServerDir: '/tmp/happier-server',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      groupId: 'main',
      activeProfileId: 'primary',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/happier-server/daemon/connected-services/homes/claude-subscription/primary/claude/claude-config',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
          {
            kind: 'profile',
            serviceId: 'claude-subscription',
            profileId: 'primary',
          },
        ]),
      },
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_shared_group_auth_surface_required',
    });
  });
});
