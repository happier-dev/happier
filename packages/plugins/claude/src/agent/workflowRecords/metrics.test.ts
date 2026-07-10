import { describe, expect, it } from 'vitest';

import { normalizeResultPreview } from './metrics.js';

describe('normalizeResultPreview', () => {
  it('converts JSON object strings into concise readable previews at the Claude boundary', () => {
    expect(normalizeResultPreview('{"lane":"shadcn-docs","summary":"Useful scroll patterns found.","ok":false}'))
      .toBe('Useful scroll patterns found.');
    expect(normalizeResultPreview('{"subsystemsAnalyzed":8}')).toBe('subsystemsAnalyzed: 8');
  });

  it('leaves ordinary text previews unchanged after trimming', () => {
    expect(normalizeResultPreview('  Found the answer.  ')).toBe('Found the answer.');
  });
});
