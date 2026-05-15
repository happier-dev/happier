import { describe, expect, it, vi } from 'vitest';

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

  it('emits turn_failed and records the issue through a caller-owned persistence hook', async () => {
    const sendAgentMessage = vi.fn();
    const recordIssue = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'codex',
      cause: 'auth_error',
      error: '401 Unauthorized raw details',
      occurredAt: 300,
      providerTurnId: 'turn_1',
      session: { sendAgentMessage },
      recordIssue,
    });

    expect(issue).not.toBeNull();
    if (issue === null) return;
    expect(issue.source).toBe('auth_error');
    expect(sendAgentMessage).toHaveBeenCalledWith('codex', expect.objectContaining({
      type: 'turn_failed',
      id: expect.any(String),
    }));
    expect(recordIssue).toHaveBeenCalledWith({
      latestTurnStatus: 'failed',
      lastRuntimeIssue: issue,
    });
  });

  it('persists failed primary-turn runtime state through the session owner when available', async () => {
    const sendAgentMessage = vi.fn();
    const updatePrimaryTurnRuntimeState = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'acp',
      cause: 'usage_limit',
      error: 'quota exceeded',
      occurredAt: 350,
      session: { sendAgentMessage, updatePrimaryTurnRuntimeState },
    });

    expect(issue).not.toBeNull();
    if (issue === null) return;
    expect(updatePrimaryTurnRuntimeState).toHaveBeenCalledWith({
      latestTurnStatus: 'failed',
      lastRuntimeIssue: issue,
    });
  });

  it('treats failed primary-turn runtime state persistence as non-fatal', async () => {
    const sendAgentMessage = vi.fn();
    const updatePrimaryTurnRuntimeState = vi.fn(async () => {
      throw new Error('update-state socket is not connected');
    });
    const recordIssue = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'acp',
      cause: 'stream_error',
      error: 'socket disconnected',
      occurredAt: 375,
      session: { sendAgentMessage, updatePrimaryTurnRuntimeState },
      recordIssue,
    });

    expect(issue).not.toBeNull();
    expect(recordIssue).toHaveBeenCalledWith(expect.objectContaining({
      latestTurnStatus: 'failed',
    }));
  });

  it('emits turn_cancelled for intentional stops without recording a runtime issue', async () => {
    const sendAgentMessage = vi.fn();
    const updatePrimaryTurnRuntimeState = vi.fn();
    const recordIssue = vi.fn();

    const issue = await surfacePrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'cancelled',
      error: 'user cancelled',
      occurredAt: 400,
      session: { sendAgentMessage, updatePrimaryTurnRuntimeState },
      recordIssue,
    });

    expect(issue).toBeNull();
    expect(sendAgentMessage).toHaveBeenCalledWith('pi', expect.objectContaining({
      type: 'turn_cancelled',
      id: expect.any(String),
    }));
    expect(updatePrimaryTurnRuntimeState).toHaveBeenCalledWith({
      latestTurnStatus: 'cancelled',
      lastRuntimeIssue: null,
    });
    expect(recordIssue).not.toHaveBeenCalled();
  });

  it('treats failed cancelled-turn runtime state persistence as non-fatal', async () => {
    const sendAgentMessage = vi.fn();
    const updatePrimaryTurnRuntimeState = vi.fn(async () => {
      throw new Error('update-state socket is not connected');
    });

    await expect(surfacePrimarySessionRuntimeIssue({
      provider: 'pi',
      cause: 'cancelled',
      error: 'user cancelled',
      occurredAt: 425,
      session: { sendAgentMessage, updatePrimaryTurnRuntimeState },
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
});
