import { describe, expect, it } from 'vitest';

import { HAPPIER_BASE_SYSTEM_PROMPT_V1 } from './systemPromptBaseV1.js';

describe('HAPPIER_BASE_SYSTEM_PROMPT_V1', () => {
  it('documents inline @path workspace file references', () => {
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('Linked workspace files');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('`@path`');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('Read tool');
  });

  it('mentions change_title for session titles', () => {
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('change_title');
  });
});
