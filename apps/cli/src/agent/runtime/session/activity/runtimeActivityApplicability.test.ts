import { describe, expect, it } from 'vitest';

import { resolveRuntimeActivityApplicability } from './runtimeActivityApplicability';

describe('resolveRuntimeActivityApplicability', () => {
  it('resolves an omitted declaration to not applicable', () => {
    expect(resolveRuntimeActivityApplicability(undefined)).toBe('not_applicable');
  });

  it.each([
    'supported',
    'unavailable',
    'not_applicable',
  ] as const)('preserves an explicit %s declaration', (applicability) => {
    expect(resolveRuntimeActivityApplicability(applicability)).toBe(applicability);
  });

  it.each([
    undefined,
    null,
    'SUPPORTED',
    true,
  ])('rejects malformed explicit declaration %p', (applicability) => {
    expect(() => resolveRuntimeActivityApplicability(applicability, { declarationPresent: true })).toThrow(
      /Runtime Activity applicability.*supported.*unavailable.*not_applicable/i,
    );
  });
});
