import { describe, expect, it, vi } from 'vitest';

import { runSelectionPostSwitchRecovery } from './runSelectionPostSwitchRecovery';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('runSelectionPostSwitchRecovery', () => {
  it('invokes provider-owned post-switch callbacks from runtime auth selections', async () => {
    const postSwitchRecover = vi.fn(async () => undefined);

    const result = await runSelectionPostSwitchRecovery({
      tracked: {
        trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        },
      },
      sessionId: 'sess_1',
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'next-profile' },
        },
      },
      serviceIds: new Set(['openai-codex']),
      action: 'restart_requested',
      runtimeAuthSelectionsByServiceId: new Map([
        ['openai-codex', { postSwitchRecover }],
      ]),
      countTrackedClaimsForStatePath: () => 0,
      hasUnknownTrackedClaims: false,
      hasInFlightTurnForStatePath: () => true,
    });

    expect(result).toEqual({ ok: true });
    expect(postSwitchRecover).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      sessionId: 'sess_1',
      action: 'restart_requested',
      countTrackedClaimsForStatePath: expect.any(Function),
      hasUnknownTrackedClaims: false,
      hasInFlightTurnForStatePath: expect.any(Function),
    }));
  });

  it('returns a failed recovery result when a provider-owned callback throws', async () => {
    const postSwitchRecover = vi.fn(async () => {
      throw new Error('boom');
    });

    const result = await runSelectionPostSwitchRecovery({
      tracked: {
        trackingKey: legacyPidSessionTrackingKey(123), startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        },
      },
      sessionId: 'sess_1',
      normalizedBindings: {
        v: 2,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'next-profile' },
        },
      },
      serviceIds: new Set(['openai-codex']),
      action: 'restart_requested',
      runtimeAuthSelectionsByServiceId: new Map([
        ['openai-codex', { postSwitchRecover }],
      ]),
      countTrackedClaimsForStatePath: () => 0,
      hasUnknownTrackedClaims: false,
    });

    expect(result).toEqual({ ok: false, errorCode: 'post_switch_recovery_failed' });
  });
});
