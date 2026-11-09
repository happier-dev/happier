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

describe('classifyClaudeUnifiedInjectionFailure', () => {
  it('retries recoverable failures that happened before any possible terminal write', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({}))).toEqual({
      kind: 'retry',
    });
  });

  it('waits for provider confirmation when bytes may have reached Claude', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      reason: 'timeout',
    }))).toEqual({
      kind: 'await_provider_confirmation',
    });
  });

  it('terminalizes non-recoverable host failures', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({
      recoverable: false,
      reason: 'pane_dead',
      phase: 'liveness',
    }))).toEqual({
      kind: 'terminal_failure',
    });
  });

  it('hands possible-effect failures to the host without blocking later injection', () => {
    expect(classifyClaudeUnifiedInjectionFailure(failedInjection({
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
    }))).toEqual({
      kind: 'handoff_ambiguous_failure',
    });
  });
});
