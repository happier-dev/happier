import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventV1Schema } from '@happier-dev/protocol';

import {
  classifyPrimarySessionRuntimeIssue,
  surfacePrimarySessionRuntimeIssue,
} from './surfacePrimarySessionRuntimeIssue';

describe('surfacePrimarySessionRuntimeIssue', () => {
  it('classifies provider status errors into sanitized primary-session issues', async () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'gemini',
      cause: 'status_error',
      error: new Error('Raw provider token sk-123 leaked in original text'),
      occurredAt: 100,
    });

    expect(issue).toMatchObject({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      source: 'provider_status_error',
      provider: 'gemini',
      occurredAt: 100,
    });
    expect(JSON.stringify(issue)).not.toContain('sk-123');
  });

  it('preserves sanitized model-not-found details from nested provider errors', async () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'opencode',
      cause: 'session_error',
      error: {
        message: 'OpenCode session failed',
        data: {
          message: 'Model not found: anthropic/claude-sonnet-4-6.',
        },
      },
      occurredAt: 150,
    });

    expect(issue).toMatchObject({
      source: 'provider_session_error',
      sanitizedPreview: 'Model not found: anthropic/claude-sonnet-4-6',
    });
    expect(JSON.stringify(issue)).not.toContain('OpenCode session failed');
  });

  it.each([
    ['process_exit', 'provider_process_exit'],
    ['session_error', 'provider_session_error'],
    ['usage_limit', 'usage_limit'],
    ['auth_error', 'auth_error'],
    ['stream_error', 'stream_error'],
    ['permission_blocked', 'permission_blocked'],
    ['unknown', 'unknown'],
  ] as const)('classifies %s failures', async (cause, expectedSource) => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'claude',
      cause,
      error: `${cause} happened with raw details`,
      occurredAt: 200,
    });

    expect(issue.source).toBe(expectedSource);
    expect(issue.code).toBe(expectedSource);
  });

  it('publishes a typed turn-failed runtime event without legacy projection by default', async () => {
    const sendAgentMessage = vi.fn();
    const publishRuntimeEvent = vi.fn();
    const recordIssue = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'auth_error',
      error: '401 Unauthorized raw details',
      occurredAt: 300,
      sessionTurnId: 'session-turn-1',
      providerTurnId: 'provider-turn-1',
      session: {
        sessionId: 'happy-session-1',
        sendAgentMessage,
      },
      publishRuntimeEvent,
      recordIssue,
    });

    expect(issue).not.toBeNull();
    if (issue === null) return;
    expect(issue.source).toBe('auth_error');
    expect(sendAgentMessage).not.toHaveBeenCalled();
    const event = RuntimeEventV1Schema.parse(publishRuntimeEvent.mock.calls[0]?.[0]);
    expect(event).toEqual(expect.objectContaining({
      kind: 'turn-failed',
      sessionId: 'happy-session-1',
      emittedAtMs: 300,
      turnId: 'session-turn-1',
      providerTurnId: 'provider-turn-1',
      issue,
    }));
    expect(event.turnId).not.toBe(event.providerTurnId);
    expect(recordIssue).toHaveBeenCalledWith({
      provider: 'claude',
      providerTurnId: 'provider-turn-1',
      latestTurnStatus: 'failed',
      lastRuntimeIssue: issue,
    });
  });

  it('emits ACP turn_failed markers only when explicitly requested as ACP compatibility', async () => {
    const sendAgentMessage = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'acp',
      cause: 'usage_limit',
      error: 'quota exceeded',
      occurredAt: 350,
      session: { sendAgentMessage },
      emitAcpLifecycleMarker: true,
    });

    expect(issue).not.toBeNull();
    expect(sendAgentMessage).toHaveBeenCalledWith('acp', expect.objectContaining({
      type: 'turn_failed',
      id: expect.any(String),
    }));
  });

  it('ignores stale primary-turn projection compatibility input', async () => {
    const sendAgentMessage = vi.fn();
    const legacyWriter = vi.fn(async () => {
      throw new Error('update-state socket is not connected');
    });
    const recordIssue = vi.fn();
    const legacyWriterKey = ['updatePrimaryTurn', 'RuntimeState'].join('');
    const legacyCompatibilityKey = ['primaryTurnRuntimeState', 'Compatibility'].join('');

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'acp',
      cause: 'stream_error',
      error: 'socket disconnected',
      occurredAt: 375,
      session: { sendAgentMessage, [legacyWriterKey]: legacyWriter } as never,
      [legacyCompatibilityKey]: 'acp-only',
      recordIssue,
    } as never);

    expect(issue).not.toBeNull();
    expect(legacyWriter).not.toHaveBeenCalled();
    expect(recordIssue).toHaveBeenCalledWith(expect.objectContaining({
      latestTurnStatus: 'failed',
    }));
  });

  it('publishes a typed turn-cancelled runtime event without recording a runtime issue', async () => {
    const sendAgentMessage = vi.fn();
    const publishRuntimeEvent = vi.fn();
    const recordIssue = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'pi',
      sessionTurnId: 'session-turn-cancelled-1',
      providerTurnId: 'provider-turn-cancelled-1',
      cause: 'cancelled',
      error: 'user cancelled',
      occurredAt: 400,
      session: {
        sessionId: 'happy-session-1',
        sendAgentMessage,
      },
      publishRuntimeEvent,
      recordIssue,
    });

    expect(issue).toBeNull();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(RuntimeEventV1Schema.parse(publishRuntimeEvent.mock.calls[0]?.[0])).toEqual(expect.objectContaining({
      kind: 'turn-cancelled',
      sessionId: 'happy-session-1',
      emittedAtMs: 400,
      turnId: 'session-turn-cancelled-1',
      providerTurnId: 'provider-turn-cancelled-1',
      reason: 'cancelled',
    }));
    expect(recordIssue).not.toHaveBeenCalled();
  });

  it('keeps cancelled ACP lifecycle markers behind explicit ACP compatibility', async () => {
    const sendAgentMessage = vi.fn();

    await expect(surfacePrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'cancelled',
      error: 'user cancelled',
      occurredAt: 425,
      session: { sendAgentMessage },
      emitAcpLifecycleMarker: true,
    })).resolves.toBeNull();

    expect(sendAgentMessage).toHaveBeenCalledWith('pi', expect.objectContaining({
      type: 'turn_cancelled',
    }));
  });

  it.each([
    ['status_error', '401 Unauthorized: login required', 'auth_error'],
    ['status_error', 'usage limit reached: upgrade your plan', 'usage_limit'],
    ['status_error', 'permission denied by policy', 'permission_blocked'],
  ] as const)('maps observable %s text to %s source', (cause, error, source) => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'acp',
      cause,
      error,
      occurredAt: 500,
    });

    expect(issue.source).toBe(source);
    expect(issue.code).toBe(source);
  });

  it('projects runtime-auth usage-limit classifications into normalized issue details', () => {
    const issue = classifyPrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'status_error',
      error: {
        runtimeAuthClassification: {
          kind: 'rate_limit',
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: 'pool',
          resetsAtMs: 1_234_000,
          retryAfterMs: 30_000,
          planType: 'plus',
          rateLimits: {
            providerLimitId: 'daily_tokens',
            quotaScope: 'workspace',
            action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
          },
        },
      },
      occurredAt: 600,
    });

    expect(issue).toMatchObject({
      source: 'usage_limit',
      code: 'usage_limit',
      usageLimit: {
        resetAtMs: 1_234_000,
        retryAfterMs: 30_000,
        quotaScope: 'workspace',
        recoverability: 'switch_account',
        providerLimitId: 'daily_tokens',
        planType: 'plus',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
        connectedService: {
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: 'pool',
        },
      },
    });
  });
});
