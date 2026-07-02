import { describe, expect, it } from 'vitest';

import { buildPromptPlanV1, renderPromptPlanV1 } from '@happier-dev/protocol';

import { resolveCodingProviderBehaviorBlocks } from '@/agent/prompting/coding/providerPromptBehaviorRegistry';

import { getClaudeRemoteSystemPrompt } from './remoteSystemPrompt';

function renderClaudeBaseProviderPrompt(): string {
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'coding',
    blocks: resolveCodingProviderBehaviorBlocks({ providerId: 'claude' }),
  }));
}

describe('getClaudeRemoteSystemPrompt', () => {
  it('does not duplicate the shared session-title instruction, which belongs to the base coding prompt', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    expect(getClaudeRemoteSystemPrompt({ disableTodos: false })).not.toContain('change-title tool');
  });

  it('returns the base prompt unchanged when disableTodos is false', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    const prompt = getClaudeRemoteSystemPrompt({ disableTodos: false });
    expect(prompt).toBe(renderClaudeBaseProviderPrompt());
  });

  it('adds a disable-TODOs instruction when disableTodos is true', () => {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';
    const basePrompt = getClaudeRemoteSystemPrompt({ disableTodos: false });
    const prompt = getClaudeRemoteSystemPrompt({ disableTodos: true });
    expect(prompt).toContain('Do not create TODO');
    expect(prompt.startsWith(basePrompt)).toBe(true);
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
