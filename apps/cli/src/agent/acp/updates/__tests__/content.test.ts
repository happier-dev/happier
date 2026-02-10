import { describe, expect, it } from 'vitest';

import { extractToolOutput } from '../content';

describe('extractToolOutput', () => {
  it('falls back to content when output is an empty string', () => {
    const update = { output: '', content: 'non-empty' } as any;
    expect(extractToolOutput(update)).toBe('non-empty');
  });

  it('prefers output when output is non-empty', () => {
    const update = { output: 'stdout', content: 'content' } as any;
    expect(extractToolOutput(update)).toBe('stdout');
  });
});

