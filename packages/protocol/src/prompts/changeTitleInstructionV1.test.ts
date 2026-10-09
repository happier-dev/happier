import { describe, expect, it } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION_V1, buildChangeTitleInstructionV1, shouldAppendChangeTitleInstructionV1 } from './changeTitleInstructionV1.js';

describe('changeTitleInstructionV1', () => {
  it('retains the exact predecessor Gemini replay suffix independently of live title guidance', () => {
    // ../0.2 HEAD 37a6541578749067b49d4579be8c752c9591b8c8, prompts/changeTitleInstructionV1.ts and tools/v2/aliases.ts.
    expect(CHANGE_TITLE_INSTRUCTION_V1).toBe(`Before you respond, call the change-title tool once to set (or update) a short, descriptive session title based on the user's message.

The tool may be exposed under different names depending on the provider. Prefer "mcp__happier__change_title" when available; otherwise use an equivalent alias (for example: change_title, session_title_set, change-title).

Never violate the user's explicit constraints on tool usage (for example: "exactly one tool call" or "do not use any other tools"). If the user has constrained tool usage for this turn, skip calling the change-title tool.

Call this tool again if the task changes significantly.`);
  });
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

    it('uses persona guidance without task-by-task renaming for newly created Bots', () => {
      const text = buildChangeTitleInstructionV1({ createdAsBot: true, preferredToolName: 'title_alias' });
      expect(text).toContain('title_alias');
      expect(text).toMatch(/persona name/i);
      expect(text).toMatch(/preserve[\s\S]*explicit[\s\S]*name/i);
      expect(text).not.toContain('task changes significantly');
    });

    it('respects unavailable and disabled title policy for persona naming', () => {
      for (const opts of [
        { createdAsBot: true, sessionTitleToolAvailable: false },
        { createdAsBot: true, settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'disabled' } } },
      ]) {
        expect(buildChangeTitleInstructionV1(opts)).toBe('');
      }
      expect(buildChangeTitleInstructionV1({ sessionTitleToolAvailable: false })).toBe('');
    });
  });
});
