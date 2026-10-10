import { describe, expect, it, vi } from 'vitest';

import { createConnectedServicePredictiveSwitchGuard } from './connectedServicePredictiveSwitchGuard';

const SERVICE_ID = 'openai-codex' as const;

describe('createConnectedServicePredictiveSwitchGuard', () => {
  it.each(['soft_threshold', 'usage_limit', 'auth_expired'] as const)(
    'suppresses %s after requester admission is lost', async (reason) => {
      const guard = createConnectedServicePredictiveSwitchGuard({
        // Current admission is an authenticated Home boundary; capability and policy remain real.
        isSessionCurrent: async () => false,
        resolvePredictiveSoftSwitchMode: async () => 'supported_in_turn',
      });

      await expect(guard({
        sessionId: 'bob-session', serviceId: SERVICE_ID, groupId: 'bob-group',
        activeProfileId: 'bob-subscription', reason,
      })).resolves.toEqual({ status: 'suppress', reason: 'requester_session_not_current' });
    },
  );

  it('rechecks requester admission after capability preparation', async () => {
    let current = true;
    const guard = createConnectedServicePredictiveSwitchGuard({
      isSessionCurrent: async () => current,
      resolvePredictiveSoftSwitchMode: async () => {
        current = false;
        return 'supported_in_turn';
      },
    });

    await expect(guard({
      sessionId: 'bob-session', serviceId: SERVICE_ID, groupId: 'bob-group',
      activeProfileId: 'bob-subscription', reason: 'soft_threshold',
    })).resolves.toEqual({ status: 'suppress', reason: 'requester_session_not_current' });
  });

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

  it('allows in-flight hard fanout when the runtime declares in-turn apply support', async () => {
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode: vi.fn(async () => 'supported_in_turn' as const),
      readTurnState: vi.fn(() => ({ inFlight: true })),
    });

    await expect(guard({
      sessionId: 'session-1',
      serviceId: SERVICE_ID,
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'same_provider_account_exhausted',
    })).resolves.toEqual({ status: 'allow' });
  });

});
