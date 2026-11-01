import { describe, expect, it } from 'vitest';

import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { resolveClaudeRemoteLaunchErrorDisposition } from './claudeRemoteLauncher';
import { ClaudeResumeSessionUnavailableError } from './utils/claudeCheckSession';
import { ClaudeNativeProviderExitUnverifiedError } from './sdk/types';

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
      error: new Error('Ordinary provider failure'),
    })).toBe('surface');
  });

  it.each([
    ['direct', Object.assign(new Error('Owned process termination could not be verified'), {
      code: 'process_tree_termination_incomplete',
    })],
    ['wrapped', new AggregateError([
      new Error('Provider runtime failed'),
      Object.assign(new Error('Owned process termination could not be verified'), {
        code: 'process_tree_termination_incomplete',
      }),
    ], 'Provider runtime failed with incomplete cleanup')],
  ] as const)('stops replacement admission after %s owned cleanup failure, including mode switches', (_label, error) => {
    for (const exitReason of [null, 'switch'] as const) {
      expect(resolveClaudeRemoteLaunchErrorDisposition({
        exitReason,
        runtimeTerminationStarted: false,
        error,
      })).toBe('preserve-resume-and-exit');
    }
  });

  it.each([
    ['direct', new ClaudeNativeProviderExitUnverifiedError()],
    ['wrapped', new AggregateError([
      new Error('Provider runtime failed'),
      new ClaudeNativeProviderExitUnverifiedError(),
    ], 'Provider exit remains unverified')],
  ] as const)('stops replacement admission after %s unverified native provider exit, including mode switches', (_label, error) => {
    for (const exitReason of [null, 'switch'] as const) {
      expect(resolveClaudeRemoteLaunchErrorDisposition({
        exitReason,
        runtimeTerminationStarted: false,
        error,
      })).toBe('preserve-resume-and-exit');
    }
  });

  it('preserves launcher-owned switch and exit teardown', () => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: 'switch',
      runtimeTerminationStarted: false,
    })).toBe('ignore');
  });

  it.each(['claude-session-1', 'claude-predecessor', null])('stops a failed resume of the current identity after launching with %s', sessionIdAtLaunchStart => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
      error: new ClaudeResumeSessionUnavailableError('claude-session-1'),
      exitCode: null,
      userAbort: false,
      sessionIdAtLaunchStart,
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

  it.each(['claude-session-1', 'claude-session-2'])('does not apply a stale resume failure to the current identity after launching with %s', sessionIdAtLaunchStart => {
    expect(resolveClaudeRemoteLaunchErrorDisposition({
      exitReason: null,
      runtimeTerminationStarted: false,
      error: new ClaudeResumeSessionUnavailableError('claude-session-1'),
      exitCode: null,
      userAbort: false,
      sessionIdAtLaunchStart,
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
