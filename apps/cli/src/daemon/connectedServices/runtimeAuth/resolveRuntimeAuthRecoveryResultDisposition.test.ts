import { describe, expect, it } from 'vitest';
import { DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS, resolveRuntimeAuthRecoveryResultDisposition } from './resolveRuntimeAuthRecoveryResultDisposition';

describe('runtime auth quota wait disposition', () => {
  it.each([
    { activeProfileId: 'primary', expected: 500_000 },
    { activeProfileId: 'backup', expected: 31_000 },
    { activeProfileId: null, expected: 31_000 },
    { activeProfileId: undefined, expected: 500_000 },
  ])('scopes classification resets to the observed current member ($activeProfileId)', ({ activeProfileId, expected }) => {
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: { status: 'no_eligible_member', groupExhausted: true,
      ...(activeProfileId === undefined ? {} : { activeProfileId }), generation: 2, retryAtMs: null, excluded: [] },
      classificationProfileId: 'primary', classificationFailureKind: 'usage_limit',
      classificationResetsAtMs: 600_000, additionalWaitCandidatesMs: [500_000], nowMs: 1_000,
    })).toMatchObject({ kind: 'durable_wait', nextRetryAtMs: expected });
  });

  it('PORT-PS-AB waits on the adopted member quota reset after a superseded plan failure', () => {
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: { status: 'no_eligible_member', groupExhausted: true,
      activeProfileId: 'backup', generation: 2, retryAtMs: 180_000,
      excluded: [{ profileId: 'backup', reason: 'quota_exhausted', retryAtMs: 180_000 }] },
      classificationProfileId: 'primary', classificationFailureKind: 'plan', classificationResetsAtMs: null, nowMs: 1_000,
    })).toMatchObject({ kind: 'durable_wait', nextRetryAtMs: 180_000 });
  });

  it('uses the existing unknown-quota backoff despite a different failed member reset', () => {
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: { status: 'quota_proof_unavailable', activeProfileId: 'backup', generation: 2 },
      classificationProfileId: 'primary', classificationResetsAtMs: 600_000, additionalWaitCandidatesMs: [500_000],
      unknownNoEligibleMemberBackoffMs: 60_000, nowMs: 1_000,
    })).toMatchObject({ kind: 'durable_wait', reason: 'quota_proof_unavailable', nextRetryAtMs: 61_000 });
  });

  it.each([20_000, 301_000])('PORT-PS-AB honors the earliest explicit provider quota boundary %s', retryAtMs => {
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: { status: 'quota_proof_unavailable',
      activeProfileId: 'backup', generation: 2, retryAtMs }, nowMs: 1_000, classificationResetsAtMs: null,
    })).toMatchObject({ kind: 'durable_wait', nextRetryAtMs: retryAtMs > 1_000 ? retryAtMs : 31_000 });
  });

  it.each([null, 500])('reuses the quota backoff for absent or stale reset %s', resetsAtMs => {
    for (const result of [{ status: 'not_group_selection' }, { status: 'recovery_action_required',
      action: { kind: 'profile_action_required', reason: 'usage_limit' } }]) {
      expect(resolveRuntimeAuthRecoveryResultDisposition({ result, classificationResetsAtMs: resetsAtMs,
        classificationFailureKind: 'usage_limit', nowMs: 1_000 })).toEqual({
        kind: 'durable_wait', reason: 'awaiting_limit_reset', nextRetryAtMs: 1_000 + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS,
      });
    }
  });
  it('honors a provider reset without extending unknown rate limits', () => {
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: { status: 'not_group_selection' },
      classificationResetsAtMs: 5_000, classificationFailureKind: 'usage_limit', nowMs: 1_000 }))
      .toMatchObject({ kind: 'durable_wait', nextRetryAtMs: 5_000 });
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: { status: 'not_group_selection' },
      classificationResetsAtMs: null, classificationFailureKind: 'rate_limit', nowMs: 1_000 }))
      .not.toMatchObject({ kind: 'durable_wait' });
  });
  it('refuses instead of waiting when no pool member can serve the refused model', () => {
    const exhausted = { status: 'switch_attempted', result: { status: 'no_eligible_member', groupExhausted: true,
      generation: 7, excluded: [{ profileId: 'second', reason: 'plan_unavailable', retryAtMs: 86_401_000 }] } };
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: exhausted, classificationResetsAtMs: null,
      classificationFailureKind: 'plan', nowMs: 1_000 })).toEqual({ kind: 'terminal', reason: 'no_eligible_member' });
    // Reset-bound limits keep waiting for the earliest member reset.
    expect(resolveRuntimeAuthRecoveryResultDisposition({ result: exhausted, classificationResetsAtMs: null,
      classificationFailureKind: 'usage_limit', nowMs: 1_000 })).toMatchObject({ kind: 'durable_wait', reason: 'no_eligible_member' });
  });
});
