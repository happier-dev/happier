import { describe, expect, it } from 'vitest';

import {
  isTerminalClaudeAgentSdkProviderTaskStatus,
  normalizeClaudeActivityStatusSignal,
  normalizeClaudeAgentSdkProviderTaskId,
  normalizeClaudeAgentSdkProviderTaskStatus,
  readClaudeAgentSdkProviderTaskStatus,
} from './activityStatus.js';

describe('Claude activity status helpers', () => {
  it('keeps the neutral Claude activity status vocabulary canonical', () => {
    expect(normalizeClaudeActivityStatusSignal('completed')).toBe('complete');
    expect(normalizeClaudeActivityStatusSignal('done')).toBe('complete');
    expect(normalizeClaudeActivityStatusSignal('running')).toBe('active');
    expect(normalizeClaudeActivityStatusSignal(undefined, 'task_started')).toBe('active');
    expect(normalizeClaudeActivityStatusSignal('failed')).toBe('failed');
    expect(normalizeClaudeActivityStatusSignal('stopped')).toBe('cancelled');
    expect(normalizeClaudeActivityStatusSignal('succeeded')).toBe('unknown');
  });

  it('classifies a just-launched agent as active, not unknown', () => {
    // OBSERVED: a Dynamic Workflow agent carries `state: 'start'` from launch until its first
    // progress tick. Missing from the vocabulary, every launching agent read `unknown` — a live
    // agent rendered as a status the roster has no tone for.
    expect(normalizeClaudeActivityStatusSignal('start')).toBe('active');
    expect(normalizeClaudeActivityStatusSignal('started')).toBe('active');
  });

  it('centralizes Agent SDK provider task id/status normalization and terminal vocabulary', () => {
    expect(normalizeClaudeAgentSdkProviderTaskId(' task-1 ')).toBe('task-1');
    expect(normalizeClaudeAgentSdkProviderTaskId('   ')).toBeNull();
    expect(normalizeClaudeAgentSdkProviderTaskId(42)).toBeNull();

    expect(normalizeClaudeAgentSdkProviderTaskStatus(' Succeeded ')).toBe('succeeded');
    expect(readClaudeAgentSdkProviderTaskStatus({ patch: { status: 'Running' } })).toBe('running');
    expect(readClaudeAgentSdkProviderTaskStatus({ status: ' Errored ' })).toBe('errored');

    for (const status of [
      'completed',
      'succeeded',
      'success',
      'stopped',
      'failed',
      'error',
      'errored',
      'killed',
      'cancelled',
      'canceled',
    ]) {
      expect(isTerminalClaudeAgentSdkProviderTaskStatus(status)).toBe(true);
    }
    expect(isTerminalClaudeAgentSdkProviderTaskStatus('running')).toBe(false);
    expect(isTerminalClaudeAgentSdkProviderTaskStatus('async_launched')).toBe(false);
    expect(isTerminalClaudeAgentSdkProviderTaskStatus('unknown')).toBe(false);
  });
});
