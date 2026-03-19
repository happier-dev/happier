import { describe, expect, it } from 'vitest';

import { formatGeminiPromptDebugSummary } from './formatGeminiPromptDebugSummary';

describe('formatGeminiPromptDebugSummary', () => {
  it('logs only a bounded preview instead of the full prompt body', () => {
    const prompt = 'a'.repeat(100) + 'SECRET_SUFFIX';

    const summary = formatGeminiPromptDebugSummary(prompt);

    expect(summary).toBe(`[gemini] Sending prompt to Gemini (length: 113): ${'a'.repeat(100)}...`);
    expect(summary).not.toContain('SECRET_SUFFIX');
  });
});
