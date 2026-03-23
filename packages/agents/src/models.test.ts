import { describe, expect, it } from 'vitest';

import { getAgentModelConfig, getAgentStaticModels } from './models.js';

describe('agent model config', () => {
  it('uses the same name and description contract for static models as dynamic models', () => {
    const claude = getAgentModelConfig('claude');
    const gemini = getAgentModelConfig('gemini');
    const claudeModels = getAgentStaticModels('claude');
    const geminiModels = getAgentStaticModels('gemini');

    expect(claude.staticModels?.find((model) => model.id === 'claude-opus-4-6')).toMatchObject({
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      description: expect.any(String),
    });
    expect(gemini.staticModels?.find((model) => model.id === 'gemini-3.1-pro-preview')).toMatchObject({
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview',
      description: expect.any(String),
    });
    expect(claude.staticModels?.map((model) => model.id)).toEqual(claude.allowedModes);
    expect(gemini.staticModels?.map((model) => model.id)).toEqual(gemini.allowedModes);
    expect(claudeModels[0]).toEqual({
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      description: expect.any(String),
    });
    expect(geminiModels[0]?.name).toBe('Gemini 2.5 Pro');
  });
});
