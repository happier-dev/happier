import { describe, expect, it } from 'vitest';

import { coerceSessionUserPromptV1 } from './coerceSessionUserPromptV1.js';

describe('coerceSessionUserPromptV1', () => {
  it('extracts text from canonical transcript user records', () => {
    const result = coerceSessionUserPromptV1({
      role: 'user',
      content: { type: 'text', text: 'hello' },
      meta: { source: 'ui' },
    });

    expect(result).toEqual({ text: 'hello' });
  });

  it('extracts text from legacy user records with string content', () => {
    const result = coerceSessionUserPromptV1({
      role: 'user',
      content: 'hello legacy',
    });

    expect(result).toEqual({ text: 'hello legacy' });
  });

  it('extracts text from user records with content blocks', () => {
    const result = coerceSessionUserPromptV1({
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });

    expect(result).toEqual({ text: 'ab' });
  });
});

