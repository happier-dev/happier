import { describe, expect, it } from 'vitest';

import {
  buildPiRuntimeModelsSnapshot,
  createPiModelCatalogEntry,
} from './catalog.js';

describe('Pi model catalog projection', () => {
  it('uses one provider-qualified identity and Thinking option shape', () => {
    expect(createPiModelCatalogEntry({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      name: 'GPT-4o mini',
      supportsThinking: true,
      thinkingEffort: 'high',
    })).toEqual({
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o mini',
      description: 'openai',
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Max' },
        ],
      }],
    });
  });

  it('projects Pi runtime state using the same identities as preflight', () => {
    expect(buildPiRuntimeModelsSnapshot({
      state: {
        model: { provider: 'openai', id: 'gpt-4o-mini' },
        thinkingLevel: 'xhigh',
      },
      availableModels: {
        models: [{ provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: true }],
      },
    })).toEqual({
      currentModelId: 'openai/gpt-4o-mini',
      models: [{
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o mini',
        description: 'openai',
        modelOptions: [expect.objectContaining({
          id: 'reasoning_effort',
          currentValue: 'xhigh',
        })],
      }],
    });
  });
});
