import { describe, expect, it, vi } from 'vitest';

import { createConnectedServicePredictiveSwitchGuard } from './connectedServicePredictiveSwitchGuard';

const SERVICE_ID = 'openai-codex' as const;

describe('createConnectedServicePredictiveSwitchGuard', () => {
  it('suppresses predictive soft-threshold switching for restart-only providers', async () => {
    const resolvePredictiveSoftSwitchMode = vi.fn(async () => 'unsupported' as const);
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode,
      readTurnState: vi.fn(() => ({ inFlight: false })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    });
    expect(resolvePredictiveSoftSwitchMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    });
  });

  it('suppresses predictive soft-threshold switching while the canonical turn state is still in flight', async () => {
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode: vi.fn(async () => 'supported' as const),
      readTurnState: vi.fn(() => ({ inFlight: true })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });

  it('allows predictive soft-threshold switching in flight when provider runtime apply supports it', async () => {
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode: vi.fn(async () => 'supported' as const),
      runtimeAuthApplyCapabilityResolver: vi.fn(async () => ({
        directLiveHotAuth: {
          supportsInTurnApply: true,
          requiresExactRuntimeIdentity: true,
          refreshSelectionResync: 'required',
          authMode: {
            kind: 'external_token_injection',
            surface: 'codex_chatgpt_auth_tokens',
          },
        },
      } as const)),
      readTurnState: vi.fn(() => ({ inFlight: true })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({ status: 'allow' });
  });

  it('suppresses predictive soft-threshold switching for a partial runtime apply capability', async () => {
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode: vi.fn(async () => 'supported' as const),
      runtimeAuthApplyCapabilityResolver: vi.fn(async () => ({
        directLiveHotAuth: { supportsInTurnApply: true },
      }) as never),
      readTurnState: vi.fn(() => ({ inFlight: true })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    })).resolves.toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });
});
