import { describe, expect, it } from 'vitest';

import { summarizeDirectSessionTitleText } from './summarizeDirectSessionTitleText';

describe('summarizeDirectSessionTitleText', () => {
  it('normalizes whitespace and truncates long text', () => {
    expect(summarizeDirectSessionTitleText('  hello\n\nworld  ')).toBe('hello world');
    expect(summarizeDirectSessionTitleText('x'.repeat(200), { maxChars: 24 })).toBe(`${'x'.repeat(23)}…`);
  });

  it('returns null for empty text', () => {
    expect(summarizeDirectSessionTitleText('   ')).toBeNull();
  });
});
