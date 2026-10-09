import { describe, expect, it } from 'vitest';

import { buildHappierBaseSystemPromptV1, HAPPIER_BASE_SYSTEM_PROMPT_V1 } from './systemPromptBaseV1.js';

describe('HAPPIER_BASE_SYSTEM_PROMPT_V1', () => {
  it('documents inline @path workspace file references', () => {
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('Linked workspace files');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('`@path`');
  });

  it('mentions change_title for session titles', () => {
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('change_title');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('first user message');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('MUST');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('Prefer "mcp__happier__change_title"');
  });

  it('documents attachment blocks so referenced files are read before answering', () => {
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('[attachments]');
    expect(HAPPIER_BASE_SYSTEM_PROMPT_V1).toContain('attachments block');
  });

  it('gives a newly created Bot one stable conditional rule for its first admitted message', () => {
    const text = buildHappierBaseSystemPromptV1({ createdAsBot: true });
    expect(text).toMatch(/first (?:admitted )?user message/i);
    expect(text).toMatch(/task or remit[\s\S]*proceed[\s\S]*without asking/i);
    expect(text).toMatch(/empty or general[\s\S]*one concise focus question/i);
    expect(text).toMatch(/later messages[\s\S]*(?:do not|never)[\s\S]*focus question/i);
    expect(text).toMatch(/persona name/i);
    expect(text).toMatch(/preserve[\s\S]*explicit[\s\S]*name/i);
    expect(text).not.toContain('task changes significantly');
    expect(buildHappierBaseSystemPromptV1()).not.toMatch(/focus question/i);
  });

  it('keeps first-message focus guidance when persona title updates are disabled or unavailable', () => {
    for (const args of [
      { createdAsBot: true, sessionTitleToolAvailable: false },
      { createdAsBot: true, settings: { codingPromptBehaviorV1: { sessionTitleUpdates: 'disabled' } } },
    ]) {
      const text = buildHappierBaseSystemPromptV1(args);
      expect(text).toMatch(/one concise focus question/i);
      expect(text).not.toContain('change_title');
      expect(text).not.toContain('# Session title');
    }
  });

  it('honors explicit tool constraints in ordinary and persona title guidance', () => {
    for (const createdAsBot of [false, true]) {
      expect(buildHappierBaseSystemPromptV1({ createdAsBot })).toMatch(/constrain[\s\S]*skip[\s\S]*title/i);
    }
  });
});
