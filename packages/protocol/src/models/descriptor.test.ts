import { describe, expect, it } from 'vitest';

import {
  AgentModelOptionOverrideRuleReadSchema,
  AgentModelOptionOverrideRuleSchema,
} from './descriptor.js';

/**
 * `AgentModelOptionOverrideRuleSchema` is the canonical producer contract for the override rule,
 * and three downstream schemas derive their shape from it. Its bounds were only ever exercised
 * indirectly, from other packages, so loosening one here would have failed nothing. These tests
 * pin each bound at the owner.
 */
describe('AgentModelOptionOverrideRuleSchema', () => {
  const VALID = { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' };

  it('accepts the shape a producing agent is meant to author', () => {
    expect(AgentModelOptionOverrideRuleSchema.parse(VALID)).toEqual(VALID);
    expect(AgentModelOptionOverrideRuleSchema.parse({ optionIds: ['reasoning_effort'] }))
      .toEqual({ optionIds: ['reasoning_effort'] });
  });

  it('requires at least one option id and rejects a non-array', () => {
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: [] }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: 'reasoning_effort' }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ forcedValue: 'xhigh' }).success).toBe(false);
  });

  it('caps optionIds at 32 members', () => {
    const ids = (count: number) => Array.from({ length: count }, (_unused, index) => `option_${index}`);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ids(32) }).success).toBe(true);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ids(33) }).success).toBe(false);
  });

  it('caps each option id at 128 characters and rejects a blank one', () => {
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['a'.repeat(128)] }).success).toBe(true);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['a'.repeat(129)] }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['reasoning_effort', ''] }).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse({ optionIds: ['   '] }).success).toBe(false);
  });

  it('caps forcedValue at 256 characters and rejects a blank one', () => {
    const rule = (forcedValue: string) => ({ optionIds: ['reasoning_effort'], forcedValue });
    expect(AgentModelOptionOverrideRuleSchema.safeParse(rule('x'.repeat(256))).success).toBe(true);
    expect(AgentModelOptionOverrideRuleSchema.safeParse(rule('x'.repeat(257))).success).toBe(false);
    expect(AgentModelOptionOverrideRuleSchema.safeParse(rule('')).success).toBe(false);
  });

  it('is strict on the write side so a producer cannot author an undeclared field', () => {
    expect(AgentModelOptionOverrideRuleSchema.safeParse({
      optionIds: ['reasoning_effort'],
      futureProducerField: 1,
    }).success).toBe(false);
  });
});

/**
 * The read schema is the single owner of the unknown-key policy for an ALREADY-persisted rule.
 * It must share every bound with the strict producer contract — otherwise a reader could accept a
 * rule the strict owner-metadata envelope would refuse to persist — and diverge on exactly one
 * axis: an unrecognized nested key is stripped rather than rejected.
 */
describe('AgentModelOptionOverrideRuleReadSchema', () => {
  const CANDIDATE_RULES: readonly unknown[] = [
    { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
    { optionIds: ['reasoning_effort'] },
    { optionIds: Array.from({ length: 33 }, (_unused, index) => `option_${index}`) },
    { optionIds: ['a'.repeat(129)] },
    { optionIds: ['reasoning_effort', ''] },
    { optionIds: [] },
    { optionIds: ['reasoning_effort'], forcedValue: 'x'.repeat(257) },
    { optionIds: ['reasoning_effort'], forcedValue: '' },
    { optionIds: 'reasoning_effort' },
    {},
    null,
  ];

  it('agrees with the strict producer contract on every bound', () => {
    for (const candidate of CANDIDATE_RULES) {
      const strict = AgentModelOptionOverrideRuleSchema.safeParse(candidate);
      const read = AgentModelOptionOverrideRuleReadSchema.safeParse(candidate);
      expect(read.success, `acceptance disagreed for ${JSON.stringify(candidate)}`).toBe(strict.success);
      if (strict.success && read.success) expect(read.data).toEqual(strict.data);
    }
  });

  it('strips an unrecognized producer field instead of rejecting the whole rule', () => {
    const parsed = AgentModelOptionOverrideRuleReadSchema.safeParse({
      optionIds: ['reasoning_effort'],
      forcedValue: 'xhigh',
      futureProducerField: 1,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data)
      .toEqual({ optionIds: ['reasoning_effort'], forcedValue: 'xhigh' });
  });
});
