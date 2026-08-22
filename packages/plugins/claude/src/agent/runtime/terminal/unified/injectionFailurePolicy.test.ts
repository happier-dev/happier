import type { TerminalInputInjectionResult } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { classifyClaudeUnifiedInjectionFailure } from './injectionFailurePolicy.js';

function failedInjection(
  overrides: Partial<Extract<TerminalInputInjectionResult, { status: 'failed' }>>,
): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: 'write_failed',
    phase: 'before_write',
    recoverable: true,
    duplicateRisk: 'none',
    observedAt: 1_000,
    ...overrides,
  };
}

const policyOptions = {
  retryAttempt: 1,
  retryLimit: 3,
  retryBaseDelayMs: 250,
};

describe('classifyClaudeUnifiedInjectionFailure', () => {
  it('retries recoverable failures that happened before any possible terminal write', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({}), policyOptions)).toEqual({
      kind: 'retry',
      retryAfterMs: 500,
    });
  });

  it('waits for provider confirmation when bytes may have reached Claude', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      reason: 'timeout',
    }), policyOptions)).toEqual({
      kind: 'await_provider_confirmation',
    });
  });

  it('terminalizes non-recoverable host failures even when retry attempts remain', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({
      recoverable: false,
      reason: 'pane_dead',
      phase: 'liveness',
    }), policyOptions)).toEqual({
      kind: 'terminal_failure',
    });
  });

  it('terminalizes recoverable no-write failures after the retry budget is exhausted', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({}), {
      ...policyOptions,
      retryAttempt: 3,
    })).toEqual({
      kind: 'terminal_failure',
    });
  });

  it('hands possible-effect failures to the host without blocking later injection', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
    }), {
      retryAttempt: 0,
      retryLimit: 3,
      retryBaseDelayMs: -1,
    })).toEqual({
      kind: 'handoff_ambiguous_failure',
    });
  });
});
