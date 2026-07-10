import { describe, expect, it } from 'vitest';

import {
  mapCodexUsageLimitSwitchProgressToProof,
  resolveCodexUsageLimitSwitchProgress,
} from './switchProgress.js';

describe('resolveCodexUsageLimitSwitchProgress', () => {
  it('does not treat a different selected profile as progress without provider verification', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'backup',
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
    expect(mapCodexUsageLimitSwitchProgressToProof(progress)).toBeNull();
  });

  it('retries when the switch has exact provider verification', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'work',
      verificationStatus: 'verified',
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'retry' });
    expect(mapCodexUsageLimitSwitchProgressToProof(progress)).toBe('fresh_candidate_selected');
  });

  it('does not treat weak Codex proof as immediate retry progress', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'observed_generation',
      exhaustedProfileId: 'work',
      selectedProfileId: 'backup',
      verificationStatus: 'weakly_verified',
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
    expect(mapCodexUsageLimitSwitchProgressToProof(progress)).toBeNull();
  });

  it('waits until reset when the switch lands on the same account', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'work',
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
    expect(mapCodexUsageLimitSwitchProgressToProof(progress)).toBeNull();
  });

  it('falls back to a non-immediate wait without reset or fallback', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'work',
      verificationStatus: null,
      resetAtMs: null,
      nowMs: 1_000,
    });

    expect(progress.kind).toBe('wait_until_reset');
    if (progress.kind === 'wait_until_reset') {
      expect(progress.nextCheckAtMs).toBeGreaterThan(1_000);
    }
  });

  it('waits until reset when the group has no eligible member but reset timing is known', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'no_eligible_member',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
    expect(mapCodexUsageLimitSwitchProgressToProof(progress)).toBeNull();
  });

  it('maps terminal no-candidate status to terminal proof when no reset timing is known', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'no_eligible_member',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: null,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'exhausted', reason: 'connected_service_group_no_eligible_member' });
    expect(mapCodexUsageLimitSwitchProgressToProof(progress)).toBe('terminal_exhausted');
  });

  it('waits until reset when the selected account is unknown', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'observed_generation',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
    });

    expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
  });

  it('falls back to the provided non-immediate wait', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'switched',
      exhaustedProfileId: 'work',
      selectedProfileId: 'work',
      verificationStatus: null,
      resetAtMs: null,
      nowMs: 1_000,
      fallbackNextCheckAtMs: 3_000,
    });

    expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 3_000 });
  });

  it('is exhausted on generation apply failure', () => {
    const progress = resolveCodexUsageLimitSwitchProgress({
      switchAttemptStatus: 'generation_apply_failed',
      exhaustedProfileId: 'work',
      selectedProfileId: null,
      verificationStatus: null,
      resetAtMs: 5_000,
      nowMs: 1_000,
      errorCode: 'hot_apply_failed',
    });

    expect(progress).toEqual({ kind: 'exhausted', reason: 'connected_service_generation_apply_failed:hot_apply_failed' });
  });

  it('waits until reset when auto-switch is unavailable', () => {
    for (const status of ['manual_strategy', 'auto_switch_disabled', 'switch_reason_disabled', 'switch_limit_reached'] as const) {
      const progress = resolveCodexUsageLimitSwitchProgress({
        switchAttemptStatus: status,
        exhaustedProfileId: 'work',
        selectedProfileId: null,
        verificationStatus: null,
        resetAtMs: 5_000,
        nowMs: 1_000,
      });

      expect(progress).toEqual({ kind: 'wait_until_reset', nextCheckAtMs: 5_000 });
    }
  });
});
