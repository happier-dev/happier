import { describe, expect, it, vi } from 'vitest';

import { resolveClaudeRemoteSessionStartPlan } from './sessionStartPlan';

describe('resolveClaudeRemoteSessionStartPlan', () => {
  it('keeps explicit session id and does not infer continue', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: 'session-1',
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: ['--continue'],
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => true,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: 'session-1', shouldContinue: false });
  });

  it('uses --continue when there is no explicit session id', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: ['--continue'],
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: null, shouldContinue: true });
  });

  it('prefers explicit --resume id over --continue', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: ['--continue', '--resume', 'resume-123'],
      },
      {
        checkSession: () => true,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemoteAgentSdk',
      },
    );

    expect(result).toEqual({ startFrom: 'resume-123', shouldContinue: false });
  });

  it('resolves --resume without id to last known session', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: null,
        transcriptPath: null,
        path: '/tmp/workspace',
        claudeConfigDir: '/tmp/claude',
        claudeArgs: ['--resume'],
      },
      {
        checkSession: () => true,
        findLastSession: () => 'last-session-id',
        hasMaterializedSessionTranscript: () => false,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemoteAgentSdk',
      },
    );

    expect(result).toEqual({ startFrom: 'last-session-id', shouldContinue: false });
  });

  it('starts fresh for a hook-only current session whose transcript has not materialized', () => {
    const logDebug = vi.fn();

    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: 'startup-only-session',
        transcriptPath: '/tmp/missing.jsonl',
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: undefined,
      },
      {
        checkSession: vi.fn(() => {
          throw new Error('checkSession should not run when transcript has not materialized');
        }),
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => false,
        logDebug,
        logPrefix: 'claudeRemoteAgentSdk',
      },
    );

    expect(result).toEqual({ startFrom: null, shouldContinue: false });
    expect(logDebug).toHaveBeenCalledWith(
      '[claudeRemoteAgentSdk] Session startup-only-session has no materialized transcript yet; starting fresh instead of resuming',
    );
  });

  it('keeps a materialized current session even when deep transcript validation is conservative', () => {
    const result = resolveClaudeRemoteSessionStartPlan(
      {
        sessionId: 'materialized-session',
        transcriptPath: '/tmp/session.jsonl',
        path: '/tmp/workspace',
        claudeConfigDir: null,
        claudeArgs: undefined,
      },
      {
        checkSession: () => false,
        findLastSession: () => null,
        hasMaterializedSessionTranscript: () => true,
        logDebug: vi.fn(),
        logPrefix: 'claudeRemote',
      },
    );

    expect(result).toEqual({ startFrom: 'materialized-session', shouldContinue: false });
  });
});
