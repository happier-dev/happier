import { describe, expect, it } from 'vitest';

import { systemPrompt } from '@/backends/claude/utils/systemPrompt';
import { getClaudeRemoteSystemPrompt } from './remoteSystemPrompt';

describe('getClaudeRemoteSystemPrompt', () => {
  it('returns the base prompt unchanged when disableTodos is false', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    const prompt = getClaudeRemoteSystemPrompt({ disableTodos: false });
    expect(prompt).toBe(systemPrompt());
  });

  it('adds a disable-TODOs instruction when disableTodos is true', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    const prompt = getClaudeRemoteSystemPrompt({ disableTodos: true });
    expect(prompt).toContain('Do not create TODO');
    expect(prompt.startsWith(systemPrompt())).toBe(true);
  });

  it('appends exactly one disable-TODOs block', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    const prompt = getClaudeRemoteSystemPrompt({ disableTodos: true });
    const occurrences = prompt.split('Do not create TODO').length - 1;
    expect(occurrences).toBe(1);
  });

  it('does not include the disable-TODOs instruction when disabled', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    const prompt = getClaudeRemoteSystemPrompt({ disableTodos: false });
    expect(prompt).not.toContain('Do not create TODO');
  });
});
