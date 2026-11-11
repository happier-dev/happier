import { describe, expect, it } from 'vitest';

import { createMemorySearchSnippet } from './memorySearchText.js';

describe('memory search snippets', () => {
  it('falls back to code-point segmentation when Hermes omits Intl.Segmenter', () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    try {
      expect(createMemorySearchSnippet('café task', 'cafe', 20)).toContain('café');
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: original });
    }
  });
});
