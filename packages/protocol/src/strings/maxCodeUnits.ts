import { check } from '../zodRuntimePolicy.js';
import type { $ZodCheck } from 'zod/v4/core';

/** Maximum preserved UTF-16 code units, independent of Zod's character-count policy. */
export function maxCodeUnits(maximum: number): $ZodCheck<string> {
  const bound = check<string>((payload) => {
    if (payload.value.length <= maximum) return;
    payload.issues.push({
      code: 'too_big',
      origin: 'string',
      maximum,
      inclusive: true,
      input: payload.value,
      inst: bound,
      continue: true,
    });
  });
  // Zod's public Core extension hook retains the existing JSON Schema bound.
  // Keep this a custom check: a native max_length definition would make the
  // compiled validator count code points even if its runtime callback changed.
  bound._zod.onattach.push((schema) => {
    const current = schema._zod.bag.maximum;
    schema._zod.bag.maximum = typeof current === 'number' ? Math.min(current, maximum) : maximum;
  });
  return bound;
}
