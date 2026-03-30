import { describe, expect, it } from 'vitest';

describe('claude system prompt composition', () => {
  it('does not include commit attribution guidance in the session prompt', async () => {
    const mod = await import('./systemPrompt');
    const getClaudeSystemPrompt = (mod as any).getClaudeSystemPrompt as (() => string) | undefined;

    expect(typeof getClaudeSystemPrompt).toBe('function');
    expect(getClaudeSystemPrompt!()).not.toContain('Co-Authored-By');
  });
});
