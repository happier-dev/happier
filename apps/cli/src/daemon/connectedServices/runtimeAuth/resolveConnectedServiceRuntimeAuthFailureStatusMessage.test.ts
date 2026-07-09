import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceRuntimeAuthFailureStatusMessage } from './resolveConnectedServiceRuntimeAuthFailureStatusMessage';

describe('resolveConnectedServiceRuntimeAuthFailureStatusMessage', () => {
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
});
