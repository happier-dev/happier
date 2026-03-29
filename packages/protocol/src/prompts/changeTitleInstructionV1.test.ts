import { describe, expect, it } from 'vitest';

import { buildChangeTitleInstructionV1, shouldAppendChangeTitleInstructionV1 } from './changeTitleInstructionV1.js';

describe('changeTitleInstructionV1', () => {
  describe('shouldAppendChangeTitleInstructionV1', () => {
    it('returns false when the user explicitly constrains tool usage (exactly one tool call)', () => {
      expect(
        shouldAppendChangeTitleInstructionV1('Run exactly one tool call:\n- Use the task tool\n- Do not use any other tools.'),
      ).toBe(false);
    });

    it('returns true for ordinary conversational prompts', () => {
      expect(shouldAppendChangeTitleInstructionV1('hello')).toBe(true);
    });
  });

  describe('buildChangeTitleInstructionV1', () => {
    it('includes the preferred tool name when provided', () => {
      const text = buildChangeTitleInstructionV1({ preferredToolName: 'mcp__happier__change_title' });
      expect(text).toContain('mcp__happier__change_title');
    });

    it('instructs the agent to set a title before answering when tools are allowed', () => {
      const text = buildChangeTitleInstructionV1({ preferredToolName: 'mcp__happier__change_title' });
      expect(text.toLowerCase()).toContain('before you respond');
      expect(text.toLowerCase()).toContain('call');
      expect(text.toLowerCase()).toContain('change-title');
    });
  });
});
