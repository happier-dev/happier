import { describe, expect, it } from 'vitest';

import {
  buildExecutionRunsGuidanceBlockV1,
  EXECUTION_RUNS_GUIDANCE_INTENTS_V1,
  isExecutionRunsGuidanceIntentV1,
} from './executionRunsGuidanceV1.js';

describe('executionRunsGuidanceV1', () => {
  it('keeps guidance intents limited to review, plan, and delegate', () => {
    expect(EXECUTION_RUNS_GUIDANCE_INTENTS_V1).toEqual(['review', 'plan', 'delegate']);
    expect(isExecutionRunsGuidanceIntentV1('review')).toBe(true);
    expect(isExecutionRunsGuidanceIntentV1('voice_agent')).toBe(false);
    expect(isExecutionRunsGuidanceIntentV1('memory_hints')).toBe(false);
  });

  it('adds an overflow note only when rules exceed the max char budget and the note fits', () => {
    const entry1 = { id: '1', description: 'Rule one' };
    const entry2 = { id: '2', description: 'Rule two is intentionally longer than the overflow note' };

    const full = buildExecutionRunsGuidanceBlockV1({ entries: [entry1, entry2], maxChars: 10_000 });
    const ruleTwoStart = full.text.indexOf('\n- Rule two');
    expect(ruleTwoStart).toBeGreaterThan(0);

    const overflowNote = '- (+1 more rules in settings)';
    const capped = buildExecutionRunsGuidanceBlockV1({
      entries: [entry1, entry2],
      maxChars: ruleTwoStart + 1 + overflowNote.length,
    });

    expect(capped.includedCount).toBe(1);
    expect(capped.remainingCount).toBe(1);
    expect(capped.text).toContain(overflowNote);
    expect(capped.text.length).toBeLessThanOrEqual(ruleTwoStart + 1 + overflowNote.length);
  });

  it('omits the rules overflow note when it would exceed the max char budget', () => {
    const entry1 = { id: '1', description: 'Rule one' };
    const entry2 = { id: '2', description: 'Rule two' };

    const full = buildExecutionRunsGuidanceBlockV1({ entries: [entry1, entry2], maxChars: 10_000 });
    const ruleTwoStart = full.text.indexOf('\n- Rule two');
    expect(ruleTwoStart).toBeGreaterThan(0);

    const capped = buildExecutionRunsGuidanceBlockV1({
      entries: [entry1, entry2],
      maxChars: ruleTwoStart,
    });

    expect(capped.includedCount).toBe(1);
    expect(capped.remainingCount).toBe(1);
    expect(capped.text).not.toContain('more rules in settings');
    expect(capped.text.length).toBeLessThanOrEqual(ruleTwoStart);
  });

  it('uses discovery-first Happier-managed run guidance when rules are present', () => {
    const result = buildExecutionRunsGuidanceBlockV1({
      entries: [
        {
          id: '1',
          description: 'Delegate reviews to a review run',
          suggestedIntent: 'review',
        },
      ],
      maxChars: 10_000,
    });

    expect(result.text).toContain('Happier-Managed Execution Runs');
    expect(result.text).toContain('action_spec_search');
    expect(result.text).toContain('action_spec_get');
    expect(result.text).toContain('action_options_resolve');
    expect(result.text).toContain('action_execute');
    expect(result.text).toContain('provider/backend');
    expect(result.text).toContain('not parallelism slots');
    expect(result.text).not.toContain('execution_run_start');
    expect(result.text).not.toContain('## Delegating via MCP');
  });
});
