import { describe, expect, it, vi } from 'vitest';

import { createConnectedServicePredictiveSwitchGuard } from './connectedServicePredictiveSwitchGuard';

const SERVICE_ID = 'openai-codex' as const;

describe('createConnectedServicePredictiveSwitchGuard', () => {
  it('cancels awaited capability preparation without suppressing it as stale admission', async () => {
    const controller = new AbortController();
    const cancelled = new Error('quota loop stopped');
    let requestSignal: AbortSignal | undefined;
    let requestStarted = false;
    let release: () => void = () => {};
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode: async ({ signal }) => {
        if (requestStarted) return 'supported_in_turn' as const;
        requestStarted = true;
        requestSignal = signal;
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return 'supported_in_turn' as const;
      },
    });
    const result = guard({ sessionId: 'quota-session', serviceId: SERVICE_ID, groupId: 'team',
      activeProfileId: 'active', reason: 'soft_threshold', ...{ signal: controller.signal } }).catch(error => error);
    controller.abort(cancelled);
    try {
      await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
      expect(await result).toBe(cancelled);
    } finally { release(); await result; }
  });

  it('allows admitted predictive capability without a requester permission dependency', async () => {
    const guard = createConnectedServicePredictiveSwitchGuard({
      resolvePredictiveSoftSwitchMode: async () => {
        return 'supported_in_turn' as const;
      },
    });

    await expect(guard({
      sessionId: 'bob-session', serviceId: SERVICE_ID, groupId: 'bob-group',
      activeProfileId: 'bob-subscription', reason: 'soft_threshold',
    })).resolves.toEqual({ status: 'allow' });
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
