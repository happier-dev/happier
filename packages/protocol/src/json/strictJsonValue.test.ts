import { describe, expect, it } from 'vitest';

import { normalizeStrictJsonValue } from './strictJsonValue.js';

function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    value = { next: value };
  }
  return value;
}

describe('normalizeStrictJsonValue', () => {
  it('delegates deep immutable cloning without imposing traversal quotas', () => {
    const authored = nested(12_000);
    let normalized: ReturnType<typeof normalizeStrictJsonValue> | undefined;

    expect(() => {
      normalized = normalizeStrictJsonValue(authored);
    }).not.toThrow();
    if (normalized === undefined) throw new Error('Expected normalized strict JSON');

    expect(normalized === authored).toBe(false);
    expect(Object.isFrozen(normalized)).toBe(true);
    let terminal: unknown = normalized;
    for (let index = 0; index < 12_000; index += 1) {
      terminal = (terminal as { next: unknown }).next;
    }
    expect(terminal).toBe('leaf');
  });

  it('does not apply the Agent Runtime byte ceiling to generic strict JSON', () => {
    const value = 'x'.repeat(1_024 * 1_024);

    expect(normalizeStrictJsonValue(value)).toBe(value);
  });
});
