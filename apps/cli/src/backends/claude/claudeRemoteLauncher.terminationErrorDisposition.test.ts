import { describe, expect, it } from 'vitest';

import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { resolveClaudeRemoteLaunchErrorDisposition } from './claudeRemoteLauncher';
import { ClaudeResumeSessionUnavailableError } from './remote/sessionStartPlan';

describe('Claude remote launch error disposition', () => {
  it('does not surface an Agent SDK child exit after runtime termination has started', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: true,
    })).toBe('terminate');
  });

  it('still surfaces the same child exit when runtime termination was not requested', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
    })).toBe('surface');
  });

  it('preserves launcher-owned switch and exit teardown', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: 'switch',
      runtimeTerminationStarted: false,
    })).toBe('ignore');
  });

  it('stops a failed resume without replacing its provider session identity', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
      error: new ClaudeResumeSessionUnavailableError('claude-session-1'),
      exitCode: null,
      userAbort: false,
      sessionIdAtLaunchStart: 'claude-session-1',
      currentSessionId: 'claude-session-1',
    })).toBe('preserve-resume-and-exit');
  });

  it('parks an existing provider session after a process failure instead of starting fresh', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
      error: new Error('Claude Code process exited with code 1'),
      exitCode: 1,
      userAbort: false,
      sessionIdAtLaunchStart: 'claude-session-1',
      currentSessionId: 'claude-session-1',
    })).toBe('preserve-resume-and-wait');
  });

  it('parks an explicitly aborted resume without replacing its provider session identity', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
      error: new Error('aborted'),
      exitCode: null,
      userAbort: true,
      sessionIdAtLaunchStart: 'claude-session-1',
      currentSessionId: 'claude-session-1',
    })).toBe('preserve-resume-and-wait');
  });

  it('does not apply resume preservation after the provider identity changed', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
      error: new ClaudeResumeSessionUnavailableError('claude-session-1'),
      exitCode: null,
      userAbort: false,
      sessionIdAtLaunchStart: 'claude-session-1',
      currentSessionId: 'claude-session-2',
    })).toBe('surface');
  });

  it('reads the canonical deferred-session termination fence without requiring an attached client', () => {
    const client = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-termination-disposition',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });

    expect(client.hasRuntimeTerminationStarted()).toBe(false);
    client.beginRuntimeTermination();
    expect(client.hasRuntimeTerminationStarted()).toBe(true);
  });
});
