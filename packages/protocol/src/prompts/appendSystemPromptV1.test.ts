import { describe, expect, it } from 'vitest';

import { buildAppendSystemPromptV1 } from './appendSystemPromptV1.js';

describe('buildAppendSystemPromptV1', () => {
  it('joins non-empty blocks with blank lines', () => {
    const out = buildAppendSystemPromptV1({
      blocks: ['Base', 'Extra'],
    });

    expect(out).toBe('Base\n\nExtra');
  });

  it('trims blocks and drops empty entries', () => {
    const out = buildAppendSystemPromptV1({
      blocks: ['  Base  ', '', '   ', '\nExtra\n'],
    });

    expect(out).toBe('Base\n\nExtra');
  });
});
