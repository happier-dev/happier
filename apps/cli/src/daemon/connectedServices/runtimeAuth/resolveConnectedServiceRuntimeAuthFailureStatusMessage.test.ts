import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceRuntimeAuthFailureStatusMessage } from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';

describe('resolveConnectedServiceRuntimeAuthFailureStatusMessage', () => {
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

  it('returns a visible scheduled status note when daemon-lifetime temporary-throttle recovery is armed', () => {
    const status = resolveConnectedServiceRuntimeAuthFailureStatusMessage({
      ok: true,
      result: {
        status: 'temporary_retry_armed',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        retryAfterMs: 45_000,
        resetAtMs: 90_000,
        recovery: {
          status: 'waiting',
          nextRetryAtMs: 90_000,
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
        resetAtMs: null,
        reason: 'manual_retry_required',
      },
    });

    expect(status).toMatchObject({
      code: 'temporary_retry_manual_retry_required',
      message: expect.stringContaining('manual'),
    });
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
