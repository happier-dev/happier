import { describe, expect, it } from 'vitest';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from './createClaudeConnectedServiceRuntimeAuthAdapter';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeStopFailureHookToUsageDetails,
} from './mapClaudeRateLimitEventToUsageDetails';

const selection = {
  serviceId: 'claude-subscription',
  activeProfileId: 'work',
  groupId: 'claude',
  generation: 42,
  credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
};

describe('classifyClaudeConnectedServiceRuntimeAuthFailure', () => {
  it('classifies Claude 401 authentication errors as credential auth failures', () => {
    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
      error: {
        type: 'assistant',
        isApiErrorMessage: true,
        api_error_status: 401,
        error: {
          type: 'authentication_error',
          message: 'Invalid authentication credentials',
        },
      },
      selection,
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'claude',
      groupGeneration: 42,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      source: 'stable_provider_message',
    });
  });

  it('classifies Claude SDK api_error auth events that report 401 via error_status', () => {
    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
      error: {
        type: 'system',
        subtype: 'api_error',
        attempt: 1,
        max_retries: 11,
        retry_delay_ms: 1_000,
        error_status: 401,
        error: 'Connection error.',
      },
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: null,
      groupId: null,
      source: 'stable_provider_message',
    });
  });

  it('keeps auth failures out of the usage-limit mapper while the runtime adapter still classifies them', () => {
    const error = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      api_error_status: 401,
      error: {
        type: 'authentication_error',
        message: 'OAuth token has expired',
      },
    };

    expect(mapClaudeRateLimitEventToUsageDetails(error)).toBeNull();
    expect(
      createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
        target: { agentId: 'claude' },
        error,
        selection,
      }),
    ).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
  });

  it('classifies auth evidence as credential failure even when retry headers are present', () => {
    const error = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      api_error_status: 401,
      error: {
        type: 'authentication_error',
        message: 'Failed to authenticate',
      },
      response: {
        headers: {
          'retry-after': '30',
          'anthropic-ratelimit-requests-reset': '2030-01-01T00:00:00.000Z',
        },
      },
    };

    expect(
      createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
        target: { agentId: 'claude' },
        error,
        selection,
      }),
    ).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: 'work',
      rateLimits: null,
    });
  });

  it('classifies auth evidence nested in Agent SDK result errors', () => {
    const error = {
      type: 'result',
      subtype: 'error_during_execution',
      errors: [
        {
          type: 'authentication_error',
          message: 'OAuth token has expired',
        },
      ],
    };

    expect(
      createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
        target: { agentId: 'claude' },
        error,
        selection,
      }),
    ).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
  });

  it('classifies Claude Code transcript authentication_failed rows as credential auth failures', () => {
    expect(
      classifyClaudeConnectedServiceRuntimeAuthFailure({
        error: {
          type: 'assistant',
          isApiErrorMessage: true,
          error: 'authentication_failed',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
          },
        },
        selection,
      }),
    ).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'claude',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
    });
  });

  it('keeps explicit usage-limit categories when the surfaced meter utilization is below 100', () => {
    // RD-CLD-5: the rejection is authoritative; a sub-100 surfaced meter (rejection on another
    // window) must not demote the classification to cooldown-only rate_limit.
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'weekly',
        utilization: 95,
      },
    });

    expect(
      classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        selection,
      }),
    ).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
    });
  });

  it('falls back to the sub-100 utilization heuristic only when details carry no explicit category', () => {
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: 'rate_limited',
      utilization: 95,
    });

    expect(details?.limitCategory).toBeUndefined();
    expect(
      classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        selection,
      }),
    ).toMatchObject({
      kind: 'rate_limit',
      limitCategory: 'rate_limit',
    });
  });

  it('classifies Claude temporary provider throttling StopFailure hooks as temporary throttles, not account usage exhaustion', () => {
    const hook = {
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      last_assistant_message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    };
    const details = mapClaudeStopFailureHookToUsageDetails(hook);

    expect(details).toMatchObject({
      providerLimitId: 'transient',
      recoverability: 'wait',
    });
    expect(
      classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        error: hook,
        selection,
      }),
    ).toMatchObject({
      kind: 'temporary_throttle',
      limitCategory: 'rate_limit',
      providerLimitId: 'transient',
    });
  });

  it('parses reset timing from the raw provider payload when mapped details lack it', () => {
    // INC-4: Claude 429s classified with resetsAtMs:null even when the raw payload carried
    // parseable reset evidence; group durable waits then degraded to rolling cooldown heuristics.
    const resetEpochSeconds = 4_102_444_800;
    const error = {
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: 'rate_limited',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Claude AI usage limit reached|${resetEpochSeconds}` }],
      },
    };
    const details = {
      ...mapClaudeRateLimitEventToUsageDetails({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 100 },
      })!,
      resetAtMs: null,
      retryAfterMs: null,
    };

    expect(
      classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        error,
        selection,
      }),
    ).toMatchObject({
      resetsAtMs: resetEpochSeconds * 1000,
    });
  });

  it('threads raw payload reset timing through the runtime-auth adapter classification', () => {
    const resetEpochSeconds = 4_102_444_800;
    expect(
      createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
        target: { agentId: 'claude' },
        error: {
          type: 'assistant',
          isApiErrorMessage: true,
          apiErrorStatus: 429,
          error: 'rate_limited',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Claude AI usage limit reached|${resetEpochSeconds}` }],
          },
        },
        selection,
      }),
    ).toMatchObject({
      kind: 'usage_limit',
      resetsAtMs: resetEpochSeconds * 1000,
    });
  });

  it('classifies Claude 529 overloaded API errors as provider capacity failures', () => {
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      error: 'server_error',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
      },
    });

    expect(details).toMatchObject({
      limitCategory: 'capacity',
      providerLimitId: 'server_overloaded',
    });
    expect(
      classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        selection,
      }),
    ).toMatchObject({
      kind: 'capacity',
      limitCategory: 'capacity',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: 'claude',
      providerLimitId: 'server_overloaded',
      source: 'structured_provider_error',
    });
  });
});
