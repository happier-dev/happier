import { describe, expect, it } from 'vitest';

import {
  GEMINI_TOOL_NAME_INFERENCE,
  hasGeminiChangeTitlePromptInstruction,
} from './toolNames.js';

describe('Gemini ACP tool names', () => {
  it('keeps change-title prompt detection in the plugin tool-name leaf', () => {
    expect(hasGeminiChangeTitlePromptInstruction('Please call mcp__happier__change_title with the new title')).toBe(true);
    expect(hasGeminiChangeTitlePromptInstruction('Use change title after the first response')).toBe(true);
    expect(hasGeminiChangeTitlePromptInstruction('Set title once you understand the task')).toBe(true);
    expect(hasGeminiChangeTitlePromptInstruction('Summarize the repository status')).toBe(false);
  });

  it('keeps the change-title aliases aligned with tool inference patterns', () => {
    const changeTitlePattern = GEMINI_TOOL_NAME_INFERENCE.patterns.find((pattern) => pattern.name === 'change_title');

    expect(changeTitlePattern?.patterns).toEqual(expect.arrayContaining([
      'mcp__happier__change_title',
      'change_title',
    ]));
  });
});
