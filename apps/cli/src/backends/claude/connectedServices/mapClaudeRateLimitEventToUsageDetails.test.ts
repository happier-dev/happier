import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeProviderFailureToUsageDetails,
  mapClaudeStopFailureHookToUsageDetails,
} from './mapClaudeRateLimitEventToUsageDetails';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import { shouldHandleConnectedServiceProviderLimitFailure } from '@/daemon/connectedServices/accountGroups/quotas/quotaLimitSelection';

describe('mapClaudeRateLimitEventToUsageDetails', () => {
  it('admits an actual failed SDK result whose rejection evidence is in result and errors', () => {
    expect(mapClaudeProviderFailureToUsageDetails({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'Claude AI usage limit reached|1792656000', errors: ['Usage limit reached'],
    })).toMatchObject({ resetAtMs: 1792656000000 });
    expect(mapClaudeProviderFailureToUsageDetails({
      type: 'result', subtype: 'success', is_error: false,
      result: 'Previously saw a usage limit reached', errors: [],
    })).toBeNull();
  });

  it('does not turn generic subscription rejection codes into unselected allowance identities', () => {
    const selection = { mode: 'selected' as const, providerLimitIds: ['five_hour', 'seven_day'] };
    for (const details of [
      mapClaudeRateLimitEventToUsageDetails({
        type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 5:30pm (Europe/Amsterdam)" }] },
      }),
      mapClaudeStopFailureHookToUsageDetails({ hook_event_name: 'StopFailure', error: 'rate_limit' }),
      mapClaudeRateLimitEventToUsageDetails({ type: 'result', is_error: true, api_error_status: 429 }),
    ]) {
      expect(details).not.toBeNull();
      const failure = classifyClaudeConnectedServiceRuntimeAuthFailure({ details });
      if (!failure) throw new Error('Expected a usage-limit classification');
      expect(failure?.providerLimitId).toBeNull();
      expect(shouldHandleConnectedServiceProviderLimitFailure({
        selection, reason: failure.kind, providerLimitId: failure.providerLimitId,
      })).toBe(true);
    }
    const excluded = classifyClaudeConnectedServiceRuntimeAuthFailure({ details: mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus' },
    }) });
    if (!excluded) throw new Error('Expected a specific allowance classification');
    expect(shouldHandleConnectedServiceProviderLimitFailure({
      selection, reason: excluded.kind, providerLimitId: excluded.providerLimitId,
    })).toBe(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps Claude SDK rate_limit_event fields into normalized usage-limit details', () => {
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-1',
      session_id: 'session-1',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1_768_100_000_000,
        rateLimitType: 'five_hour',
        utilization: 100,
        overageStatus: 'rejected',
        overageResetsAt: 1_768_200_000_000,
        overageDisabledReason: 'out_of_credits',
      },
    });

    expect(details).toEqual({
      v: 1,
      resetAtMs: 1_768_100_000_000,
      retryAfterMs: null,
      limitCategory: 'usage_limit',
      quotaScope: 'account',
      recoverability: 'wait',
      providerLimitId: 'five_hour',
      planType: null,
      utilization: 100,
      overage: {
        status: 'rejected',
        resetAtMs: 1_768_200_000_000,
        disabledReason: 'out_of_credits',
      },
      action: null,
      connectedService: null,
    });
  });

  it('marks rejected rate-limit events as explicit usage limits even when the surfaced meter is below 100', () => {
    // RD-CLD-5: a rejection can land on a window other than the one whose utilization is surfaced
    // (weekly cap hit while the 5h meter reads 9x%). The rejection is authoritative — sub-100
    // utilization must not demote the event to a cooldown-only rate_limit classification.
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-weekly-cap',
      session_id: 'session-weekly-cap',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'weekly',
        utilization: 95,
      },
    })).toMatchObject({
      limitCategory: 'usage_limit',
      utilization: 95,
    });
  });

  it('parses reset timing from rejected rate-limit event evidence when resets_at is absent', () => {
    // INC-4: the live incident's Claude 429 classified with resetsAtMs:null because the event
    // carried no resets_at field; timing evidence elsewhere in the payload was never parsed.
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-no-resets-at',
      session_id: 'session-no-resets-at',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
        utilization: 100,
        message: 'Usage limit exceeded. Try again in 2 hours',
      },
    });

    expect(details).toMatchObject({
      resetAtMs: expect.any(Number),
      retryAfterMs: 7_200_000,
    });
  });

  it('parses Claude pipe-epoch usage-limit reset timestamps from assistant error text', () => {
    // INC-4: the Claude CLI surfaces subscription limits as "Claude AI usage limit reached|<epoch>".
    const resetEpochSeconds = 4_102_444_800;
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-pipe-epoch',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Claude AI usage limit reached|${resetEpochSeconds}` }],
      },
    })).toMatchObject({
      resetAtMs: resetEpochSeconds * 1000,
    });
  });

  it('ignores allowed Claude SDK rate-limit telemetry', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-allowed',
      session_id: 'session-allowed',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1_779_097_200,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
      },
    })).toBeNull();
  });

  it('ignores Claude SDK rate-limit warning telemetry', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'rate_limit_event',
      uuid: 'event-warning',
      session_id: 'session-warning',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: 1_779_097_200,
        rateLimitType: 'five_hour',
        utilization: 90,
        surpassedThreshold: 80,
      },
    })).toBeNull();
  });

  it('maps Claude response headers into retry timing when an API error exposes them', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      response: {
        headers: {
          'retry-after': '30',
          'anthropic-ratelimit-tokens-reset': '2026-05-17T12:00:00.000Z',
        },
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: 30_000,
      quotaScope: 'account',
      recoverability: 'wait',
    });
  });

  it('maps synthetic Claude assistant API-error rate-limit records', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-1',
      isApiErrorMessage: true,
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit',
        message: 'Claude API rate limit exceeded',
        status: 429,
        api_error_status: 429,
        reset_at: '2026-05-17T12:00:00.000Z',
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
      utilization: null,
    });
  });

  it('maps synthetic Claude assistant API-error rate-limit records that report 429 via error_status', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-1',
      isApiErrorMessage: true,
      error: {
        type: 'api_error',
        message: 'Connection error.',
        error_status: 429,
        reset_at: '2026-05-17T12:00:00.000Z',
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
    });
  });

  it('marks sidechain-sourced api-error rows so consumers can keep them out of turn failure and recovery (FIX-3)', () => {
    // Subagent transcript rows are imported into the parent stream with isSidechain:true. A
    // sidechain limit is still real account-level evidence (quota snapshots may consume it),
    // but it must be distinguishable so it never fails the PARENT turn nor drives recovery.
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-sidechain-1',
      isSidechain: true,
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: {
        type: 'rate_limit_error',
        message: 'Claude AI usage limit reached|1781221200',
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: 1_781_221_200_000,
      sourcedFromSidechain: true,
    });
  });

  it('does not mark parent-chain api-error rows as sidechain-sourced', () => {
    const details = mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-parent-1',
      isSidechain: false,
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: {
        type: 'rate_limit_error',
        message: 'Claude API rate limit exceeded',
      },
    });
    expect(details).not.toBeNull();
    expect(details?.sourcedFromSidechain).toBeUndefined();
  });

  it('maps synthetic Claude result API-error status records', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      error: 'rate_limit',
      api_error_status: 429,
      retry_after_ms: 45_000,
    })).toMatchObject({
      v: 1,
      resetAtMs: null,
      retryAfterMs: 45_000,
      quotaScope: 'account',
      recoverability: 'wait',
      utilization: null,
    });
  });

  it('classifies temporary server throttling as a transient provider limit', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-transient',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      error: 'rate_limit',
      message: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
        }],
      },
    })).toMatchObject({
      v: 1,
      providerLimitId: 'transient',
      recoverability: 'wait',
    });
  });

  it('classifies Claude 529 overloaded errors as provider capacity rather than quota exhaustion', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-overloaded',
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      error: 'server_error',
      message: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
        }],
      },
    })).toMatchObject({
      v: 1,
      limitCategory: 'capacity',
      providerLimitId: 'server_overloaded',
      recoverability: 'wait',
      utilization: null,
    });
  });

  it('ignores synthetic Claude API-error records without rate-limit evidence', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-2',
      isApiErrorMessage: true,
      error: {
        type: 'authentication_error',
        message: 'Invalid API key',
        status: 401,
        api_error_status: 401,
      },
    })).toBeNull();
  });

  it('maps HTTP-date retry-after headers into a relative retry delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));

    expect(mapClaudeRateLimitEventToUsageDetails({
      response: {
        headers: {
          'retry-after': 'Sun, 17 May 2026 12:00:10 GMT',
        },
      },
    })).toMatchObject({
      retryAfterMs: 10_000,
      resetAtMs: Date.parse('2026-05-17T12:00:10.000Z'),
    });
  });

  it('maps generic reset-after headers with compact durations', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T12:00:00.000Z'));

    expect(mapClaudeRateLimitEventToUsageDetails({
      response: {
        headers: {
          'x-ratelimit-reset-after': '2m30s',
        },
      },
    })).toMatchObject({
      retryAfterMs: 150_000,
      resetAtMs: Date.parse('2026-05-17T12:02:30.000Z'),
    });
  });

  it('prefers reset timing from Claude StopFailure assistant text over the null-timing rate_limit fallback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T19:40:00.000Z'));

    expect(mapClaudeStopFailureHookToUsageDetails({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit · resets 11pm (Europe/Zurich)",
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-06-10T21:00:00.000Z'),
      retryAfterMs: 4_800_000,
      quotaScope: 'account',
      recoverability: 'wait',
    });
  });

  it('marks StopFailure usage details sourced from a sidechain agent hook (agent_id attribution)', () => {
    // A subagent usage-limit StopFailure must not fail the PARENT turn: the surfaced details
    // carry the shared sidechain attribution so surfaceClaudeRateLimitRuntimeIssue keeps the
    // canonical turn untouched while per-account usage accounting still ingests the evidence.
    expect(mapClaudeStopFailureHookToUsageDetails({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      agent_id: 'agent-123',
    })).toMatchObject({
      v: 1,
      sourcedFromSidechain: true,
    });

    expect(mapClaudeStopFailureHookToUsageDetails({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      agentId: 'agent-123',
    })).toMatchObject({ sourcedFromSidechain: true });

    // Blank/absent agent ids stay main-chain.
    expect(mapClaudeStopFailureHookToUsageDetails({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      agent_id: '  ',
    })?.sourcedFromSidechain).toBeUndefined();
  });

  it('falls back to the direct Claude StopFailure rate_limit classification when no assistant timing exists', () => {
    expect(mapClaudeStopFailureHookToUsageDetails({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
    })).toEqual({
      v: 1,
      resetAtMs: null,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
      planType: null,
      utilization: null,
      overage: null,
      action: null,
      connectedService: null,
    });
  });
});
