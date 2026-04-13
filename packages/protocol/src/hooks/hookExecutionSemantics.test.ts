import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('hook execution semantics', () => {
  it('resolves canonical execution kinds from hook categories', () => {
    const resolveExecutionKind = (protocol as any).resolveHookExecutionKindForCategoryV1 as (category: string) => string | null;
    expect(typeof resolveExecutionKind).toBe('function');

    expect(resolveExecutionKind('integration')).toBe('integrate');
    expect(resolveExecutionKind('lifecycle')).toBe('observe');
    expect(resolveExecutionKind('augmentation')).toBe('augment');
    expect(resolveExecutionKind('decision')).toBe('decide');
    expect(resolveExecutionKind('unknown')).toBe(null);
  });

  it('checks compatibility between hook categories and execution kinds', () => {
    const isCompatible = (protocol as any).isHookExecutionKindCompatibleWithCategoryV1 as (params: {
      category: string;
      executionKind: string;
    }) => boolean;
    expect(typeof isCompatible).toBe('function');

    expect(isCompatible({ category: 'integration', executionKind: 'integrate' })).toBe(true);
    expect(isCompatible({ category: 'integration', executionKind: 'observe' })).toBe(false);
    expect(isCompatible({ category: 'lifecycle', executionKind: 'observe' })).toBe(true);
    expect(isCompatible({ category: 'decision', executionKind: 'augment' })).toBe(false);
  });
});
