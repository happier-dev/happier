import { describe, expect, it } from 'vitest';

import { parseProviderManualModelInput } from './manualModelInput.js';

describe('parseProviderManualModelInput', () => {
  it('trims once, preserves case, exact-deduplicates, skips existing ids, and returns safe line-numbered rejects', () => {
    expect(parseProviderManualModelInput(
      ' model-a\nmodel-a\nModel-A\nexisting\nbad\u0000id\n',
      { existingIds: new Set(['existing']) },
    )).toEqual({
      accepted: ['model-a', 'Model-A'],
      rejected: [{ line: 5, value: 'badid' }],
    });
  });
});
