import { describe, expect, it } from 'vitest';

import {
  aggregateApplyOutcome,
  controlResultToChangeOutcome,
} from './outcome.js';

describe('controlResultToChangeOutcome — maps low-level results to the five public statuses', () => {
  it('maps applied with a timing detail', () => {
    const outcome = controlResultToChangeOutcome({
      key: 'model',
      requested: 'sonnet',
      result: { kind: 'applied', effective: 'Sonnet 4.6', timing: 'before_next_prompt' },
    });
    expect(outcome).toMatchObject({
      key: 'model',
      status: 'applied',
      timing: 'before_next_prompt',
      effective: 'Sonnet 4.6',
      requested: 'sonnet',
    });
  });

  it('maps already-effective to applied + skipped_already_effective', () => {
    const outcome = controlResultToChangeOutcome({
      key: 'reasoningEffort',
      requested: 'high',
      result: { kind: 'already_effective', effective: 'high' },
    });
    expect(outcome.status).toBe('applied');
    expect(outcome.timing).toBe('skipped_already_effective');
  });

  it('maps scheduled to applied + the scheduling timing', () => {
    const outcome = controlResultToChangeOutcome({
      key: 'model',
      requested: 'sonnet',
      result: { kind: 'scheduled', timing: 'scheduled_for_next_prompt' },
    });
    expect(outcome.status).toBe('applied');
    expect(outcome.timing).toBe('scheduled_for_next_prompt');
  });

  it('maps an unreachable mode to requires_interactive_control', () => {
    const outcome = controlResultToChangeOutcome({
      key: 'permissionMode',
      requested: 'auto',
      result: { kind: 'unreachable', reason: 'auto not reachable on this model' },
    });
    expect(outcome.status).toBe('requires_interactive_control');
  });

  it('maps restart/unsupported/failed without inventing new statuses', () => {
    expect(controlResultToChangeOutcome({ key: 'permissionMode', requested: 'dontAsk', result: { kind: 'requires_restart' } }).status).toBe('requires_restart');
    expect(controlResultToChangeOutcome({ key: 'maxThinkingTokens', requested: 4096, result: { kind: 'unsupported' } }).status).toBe('unsupported');
    expect(controlResultToChangeOutcome({ key: 'model', requested: 'sonnet', result: { kind: 'failed', reason: 'no confirmation' } }).status).toBe('failed');
  });

  it('never produces a status outside the five frozen public statuses', () => {
    const statuses = (['applied', 'already_effective', 'scheduled', 'unreachable', 'requires_restart', 'unsupported', 'failed'] as const).map((kind) => {
      const result =
        kind === 'applied' ? { kind: 'applied' as const }
        : kind === 'already_effective' ? { kind: 'already_effective' as const }
        : kind === 'scheduled' ? { kind: 'scheduled' as const, timing: 'next_idle' as const }
        : kind === 'unreachable' ? { kind: 'unreachable' as const, reason: 'x' }
        : kind === 'requires_restart' ? { kind: 'requires_restart' as const }
        : kind === 'unsupported' ? { kind: 'unsupported' as const }
        : { kind: 'failed' as const, reason: 'x' };
      return controlResultToChangeOutcome({ key: 'model', requested: 'x', result }).status;
    });
    const allowed = new Set(['applied', 'requires_restart', 'requires_interactive_control', 'unsupported', 'failed']);
    for (const status of statuses) expect(allowed.has(status)).toBe(true);
  });
});

describe('aggregateApplyOutcome — combined status and prompt gating', () => {
  it('allows the prompt to proceed when all required controls applied', () => {
    const outcome = aggregateApplyOutcome([
      { key: 'model', status: 'applied', timing: 'before_next_prompt' },
      { key: 'reasoningEffort', status: 'applied', timing: 'before_next_prompt' },
    ]);
    expect(outcome.status).toBe('applied');
    expect(outcome.promptMayProceed).toBe(true);
    expect(outcome.timing).toBe('before_next_prompt');
  });

  it('blocks the prompt when any required control failed', () => {
    const outcome = aggregateApplyOutcome([
      { key: 'model', status: 'applied' },
      { key: 'permissionMode', status: 'failed', reason: 'unverified' },
    ]);
    expect(outcome.status).toBe('failed');
    expect(outcome.promptMayProceed).toBe(false);
  });

  it('blocks the prompt when a required mode needs interactive control', () => {
    const outcome = aggregateApplyOutcome([
      { key: 'permissionMode', status: 'requires_interactive_control' },
    ]);
    expect(outcome.status).toBe('requires_interactive_control');
    expect(outcome.promptMayProceed).toBe(false);
  });

  it('blocks the prompt when a control is only scheduled/queued (not yet effective)', () => {
    const scheduled = aggregateApplyOutcome([
      { key: 'model', status: 'applied', timing: 'scheduled_for_next_prompt' },
    ]);
    expect(scheduled.status).toBe('applied');
    expect(scheduled.promptMayProceed).toBe(false);

    const queued = aggregateApplyOutcome([
      { key: 'permissionMode', status: 'applied', timing: 'queued_until_safe_window' },
    ]);
    expect(queued.promptMayProceed).toBe(false);
  });

  it('does not block the prompt for non-blocking restart/unsupported fallbacks', () => {
    const outcome = aggregateApplyOutcome([
      { key: 'maxThinkingTokens', status: 'unsupported' },
      { key: 'model', status: 'requires_restart' },
    ]);
    expect(outcome.promptMayProceed).toBe(true);
  });

  it('treats an empty change set as applied/not_applicable and lets the prompt proceed', () => {
    const outcome = aggregateApplyOutcome([]);
    expect(outcome.status).toBe('applied');
    expect(outcome.timing).toBe('not_applicable');
    expect(outcome.promptMayProceed).toBe(true);
  });
});
