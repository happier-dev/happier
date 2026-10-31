import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceRuntimeAuthFailureStatusMessage } from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';
import { connectedServiceRuntimeAuthRecoveryWillContinue } from './projection/connectedServiceRuntimeAuthRecoverySessionEvent';

describe('resolveConnectedServiceRuntimeAuthFailureStatusMessage', () => {
  it('presents unavailable quota proof as a continuing recovery', () => {
    const note = resolveConnectedServiceRuntimeAuthFailureStatusMessage({ ok: true,
      result: { status: 'switch_attempted', result: { status: 'quota_proof_unavailable', activeProfileId: 'backup', generation: 2 } },
    });
    expect(note?.code).toBe('switch_attempted_quota_proof_unavailable');
    expect(connectedServiceRuntimeAuthRecoveryWillContinue({ handled: true, statusCode: note?.code })).toBe(true);
  });

  it.each([
    {
      mode: 'restart_resume',
      expectedMessage: 'Connected-service account switched to backup; restarting session.',
    },
    {
      mode: 'hot_apply',
      expectedMessage: 'Connected-service account switched to backup; current session updated.',
    },
    {
      mode: 'spawn_next_turn',
      expectedMessage: 'Connected-service account switched to backup; the new account will apply on the next turn.',
    },
    {
      mode: undefined,
      expectedMessage: 'Connected-service account switched to backup.',
    },
  ])('describes a switched account truthfully for $mode mode', ({ mode, expectedMessage }) => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'backup',
          generation: 2,
          ...(mode ? { mode } : {}),
        },
      },
    });

    expect(status).toEqual({
      code: 'switch_attempted_switched',
      message: expectedMessage,
    });
  });

  it('returns a visible status note when switch recovery is rate-limited', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'switch_limit_reached',
          generation: 2,
        },
      },
    });

    expect(status).toMatchObject({
      code: 'switch_attempted_switch_limit_reached',
      message: expect.stringContaining('switch'),
    });
  });

  it('returns a visible status note when generation apply failed after a switch attempt', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'provider_session_state_unavailable_for_resume',
        },
      },
    });

    expect(status).toMatchObject({
      code: 'switch_attempted_generation_apply_failed',
      message: expect.stringContaining('backup'),
    });
    expect(status?.message).toContain('provider_session_state_unavailable_for_resume');
  });

  it('returns a visible status note when generation apply failed without a profile label', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: null,
          generation: 2,
          errorCode: 'metadata_update_failed',
        },
      },
    });

    expect(status).toMatchObject({
      code: 'switch_attempted_generation_apply_failed',
      message: expect.stringContaining('metadata_update_failed'),
    });
  });

  it('returns provider-facing status notes for scheduled recovery and post-switch verification failures', () => {
    const scheduled = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'recovery_retry_scheduled',
        recovery: {
          status: 'scheduled',
          retryable: true,
          nextRetryAtMs: 12_000,
        },
        originalResult: {
          status: 'switch_attempted',
          result: {
            status: 'generation_apply_failed',
            activeProfileId: 'backup',
            generation: 2,
            errorCode: 'provider_account_adoption_mismatch',
          },
        },
      },
    });
    const adoptionMismatch = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'provider_account_adoption_mismatch',
        },
      },
    });
    const verificationFailed = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'backup',
          generation: 2,
          errorCode: 'post_switch_verification_failed',
        },
      },
    });

    expect(scheduled).toMatchObject({
      code: 'recovery_retry_scheduled',
      message: expect.stringContaining('retry'),
    });
    expect(adoptionMismatch).toMatchObject({
      code: 'switch_attempted_provider_account_adoption_mismatch',
      message: expect.stringContaining('account'),
    });
    expect(verificationFailed).toMatchObject({
      code: 'switch_attempted_post_switch_verification_failed',
      message: expect.stringContaining('verify'),
    });
  });

  it('returns a visible status note when the group has no eligible fallback member', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'no_eligible_member',
          generation: 2,
          groupExhausted: true,
          retryAtMs: 12_000,
        },
      },
    });

    expect(status).toMatchObject({
      code: 'switch_attempted_no_eligible_member',
      message: expect.stringContaining('no eligible'),
    });
    expect(status?.message).toContain('group');
  });

  it('returns a visible status note when daemon refresh recovered the credential', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'credential_refreshed',
        restartRequested: true,
      },
    });

    expect(status).toMatchObject({
      code: 'credential_refreshed_restart_requested',
      message: expect.stringContaining('refreshed'),
    });
    expect(status?.message).toContain('restarting');
  });

  it('does not imply a restart when credential refresh is awaiting provider confirmation', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'credential_refreshed',
        restartRequested: false,
      },
    });

    expect(status).toMatchObject({
      code: 'credential_refreshed_awaiting_provider_outcome',
      message: expect.stringContaining('provider confirmation'),
    });
    expect(status?.message).not.toContain('restart');
  });

  it('returns a visible status note when provider state sharing is required', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'provider_state_sharing_required',
          serviceId: 'openai-codex',
          profileId: null,
          groupId: null,
          reason: 'usage_limit',
        },
      },
    });

    expect(status).toMatchObject({
      code: 'recovery_action_provider_state_sharing_required',
      message: expect.stringContaining('state sharing'),
    });
  });

  it('returns visible status notes for profile action-required states', () => {
    const profileActionStatus = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'profile_action_required',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'usage_limit',
        },
      },
    });
    const reconnectStatus = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'refresh_failed',
        },
      },
    });

    expect(profileActionStatus).toMatchObject({
      code: 'recovery_action_profile_action_required',
      message: expect.stringContaining('primary'),
    });
    expect(reconnectStatus).toMatchObject({
      code: 'recovery_action_reconnect_profile',
      message: expect.stringContaining('reconnect'),
    });
  });

  it('returns a visible scheduled status note when daemon-lifetime temporary-throttle recovery is armed', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'temporary_retry_armed',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        retryAfterMs: 45_000,
        recovery: {
          status: 'waiting',
          nextRetryAtMs: 46_000,
          attemptCount: 0,
        },
      },
    });

    expect(status).toMatchObject({
      code: 'temporary_retry_armed',
      message: expect.stringContaining('retry'),
    });
    expect(status?.message).toContain('daemon');
  });

  it('returns a visible manual-retry status note when temporary-throttle recovery is degraded', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'temporary_retry_unavailable',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        retryAfterMs: 45_000,
        reason: 'manual_retry_required',
      },
    });

    expect(status).toMatchObject({
      code: 'temporary_retry_manual_retry_required',
      message: expect.stringContaining('manual'),
    });
    expect(status?.message).toContain('retry');
  });

  it('returns visible status notes for daemon boundary failures', () => {
    const sessionNotFound = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'session_not_found' },
    });
    const selectionMismatch = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'selection_mismatch' },
    });
    const coordinatorUnavailable = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'switch_coordinator_unavailable' },
    });
    const recoveryHandlerFailed = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'recovery_handler_failed', errorCode: 'unexpected_error' },
    });
    const recoveryDeadLettered = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'recovery_dead_lettered' },
    });
    const recoveryCancelled = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'recovery_cancelled' },
    });
    const recoveryTerminal = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: { status: 'recovery_terminal' },
    });

    expect(sessionNotFound?.code).toBe('session_not_found');
    expect(selectionMismatch?.code).toBe('selection_mismatch');
    expect(coordinatorUnavailable?.code).toBe('switch_coordinator_unavailable');
    expect(recoveryHandlerFailed?.code).toBe('recovery_handler_failed');
    expect(recoveryDeadLettered?.code).toBe('recovery_dead_lettered');
    expect(recoveryCancelled?.code).toBe('recovery_cancelled');
    expect(recoveryTerminal?.code).toBe('recovery_terminal');
  });

  it('reports an interrupted old turn when an account update superseded its exact source tuple', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'previous-account',
      },
    });

    expect(status).toEqual({
      code: 'recovery_superseded_source_tuple_mismatch',
      message: 'Connected-service account already updated; the old turn was interrupted.',
    });
  });

  it('does not suppress a superseded receipt when the exact source tuple is unavailable', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_unavailable',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'previous-account',
      },
    });

    expect(status).toBeNull();
  });
});
