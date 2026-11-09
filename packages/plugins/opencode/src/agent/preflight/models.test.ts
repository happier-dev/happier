import { describe, expect, it } from 'vitest';

import { buildOpenCodeModelCatalogFromProviders } from './models.js';

describe('OpenCode native model normalization', () => {
  it('preserves empty and fully ineligible inventories without inventing models', () => {
    expect(buildOpenCodeModelCatalogFromProviders([], Date.now()).models).toEqual([]);
    expect(buildOpenCodeModelCatalogFromProviders([{ id: 'example', models: {
      image: { id: 'image', capabilities: { input: ['image'] } },
    } }], Date.now()).models).toEqual([]);
  });

  it('retains native metadata, reasoning choices and supported text models without tools', () => {
    expect(buildOpenCodeModelCatalogFromProviders([{ id: 'openai', models: {
      'gpt-5.4': {
        id: 'gpt-5.4', providerID: 'openai', name: 'GPT-5.4', family: 'gpt-5.4', status: 'active',
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
        variants: [{ id: 'low' }, { id: 'high' }], limit: { context: 400000, output: 128000 },
      },
      'no-tools': {
        id: 'no-tools', providerID: 'openai', name: 'No Tools', status: 'active',
        capabilities: { tools: false, input: ['text'] }, variants: [], limit: { context: 100000 },
      },
    } }], Date.now()).models).toEqual([{
      id: 'openai/gpt-5.4', name: 'GPT-5.4', description: 'gpt-5.4', contextWindowTokens: 400000,
      modelOptions: [{
        id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
      }],
    }, { id: 'openai/no-tools', name: 'No Tools', description: 'openai', contextWindowTokens: 100000 }]);
  });

  it('retains nested model ids and uses the provider map key when the native record omits its id', () => {
    expect(buildOpenCodeModelCatalogFromProviders([{ id: 'openrouter', models: {
      'deepseek/deepseek-v4-flash-0731': { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      '~anthropic/claude-opus-latest': { name: 'Claude Opus Latest' },
    } }], Date.now()).models).toEqual([
      { id: 'openrouter/deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash' },
      { id: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus Latest' },
    ]);
  });
});
