import { describe, expect, it } from 'vitest';

describe('claude system prompt attribution gating', () => {
  it('reads HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY at call time (no module-init caching)', async () => {
    const mod = await import('./systemPrompt');
    const getClaudeSystemPrompt = (mod as any).getClaudeSystemPrompt as (() => string) | undefined;

    expect(typeof getClaudeSystemPrompt).toBe('function');

    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    expect(getClaudeSystemPrompt!()).not.toContain('Co-Authored-By');

    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '1';
    expect(getClaudeSystemPrompt!()).toContain('Co-Authored-By');
  });
});

