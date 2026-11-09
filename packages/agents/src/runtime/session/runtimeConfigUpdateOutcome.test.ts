import { describe, expect, it } from 'vitest';

import { isRuntimeConfigUpdateOutcomeApplied, isRuntimeConfigUpdateOutcomeDeferred } from './runtimeConfigUpdateOutcome.js';

describe('isRuntimeConfigUpdateOutcomeApplied', () => {
  it('distinguishes accepted future configuration from execution evidence across every pending timing', () => {
    for (const timing of ['before_next_prompt', 'queued_until_safe_window', 'scheduled_for_next_prompt', 'next_idle'] as const) {
      expect(isRuntimeConfigUpdateOutcomeDeferred({ status: 'applied', timing })).toBe(true);
      expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing })).toBe(timing === 'before_next_prompt');
      expect(isRuntimeConfigUpdateOutcomeDeferred({ status: 'failed', timing })).toBe(false);
    }
    expect(isRuntimeConfigUpdateOutcomeDeferred(undefined)).toBe(false);
    expect(isRuntimeConfigUpdateOutcomeDeferred(null)).toBe(false);
    expect(isRuntimeConfigUpdateOutcomeDeferred({ status: 'applied', timing: 'current_window' })).toBe(false);
    expect(isRuntimeConfigUpdateOutcomeDeferred({ status: 'applied', timing: 'skipped_already_effective' })).toBe(false);
  });
  it('treats legacy bare returns as applied (back-compat)', () => {
    expect(isRuntimeConfigUpdateOutcomeApplied(undefined)).toBe(true);
    expect(isRuntimeConfigUpdateOutcomeApplied(null)).toBe(true);
  });

  it('treats applied with a final timing as applied', () => {
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied' })).toBe(true);
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing: 'current_window' })).toBe(true);
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing: 'before_next_prompt' })).toBe(true);
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing: 'skipped_already_effective' })).toBe(true);
  });

  it('keeps still-pending deferral timings pending so the synchronizer re-attempts', () => {
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing: 'queued_until_safe_window' })).toBe(false);
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing: 'scheduled_for_next_prompt' })).toBe(false);
    // next_idle means "Claude will run the control at the next idle window" — the override has NOT
    // taken effect yet, so the synchronizer must keep it pending (TUI runtime-control deferrals).
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'applied', timing: 'next_idle' })).toBe(false);
  });

  it('treats non-applied statuses as pending unless already effective', () => {
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'requires_interactive_control' })).toBe(false);
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'failed' })).toBe(false);
    expect(isRuntimeConfigUpdateOutcomeApplied({ status: 'unsupported', timing: 'skipped_already_effective' })).toBe(true);
  });
});
