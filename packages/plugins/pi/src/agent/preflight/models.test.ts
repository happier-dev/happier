import { describe, expect, it } from 'vitest';

import { buildPiPreflightModelsFromListModelsOutput } from './models.js';

describe('Pi preflight model parsing', () => {
  it('adds a Thinking option only for models that report thinking support', () => {
    const models = buildPiPreflightModelsFromListModelsOutput([
      'provider  model  context  max-out  thinking  images',
      'openai  gpt-5.4  200K  4K  yes  yes',
      'openai  gpt-4o-mini  128K  4K  no  yes',
    ].join('\n'));

    expect(models).toEqual([
      {
        id: 'openai/gpt-5.4',
        name: 'gpt-5.4',
        description: 'openai',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'Max' },
            ],
          },
        ],
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'gpt-4o-mini',
        description: 'openai',
      },
    ]);
  });

  it('returns null when Pi emits no parseable model rows', () => {
    expect(buildPiPreflightModelsFromListModelsOutput('provider model\n')).toBeNull();
    expect(buildPiPreflightModelsFromListModelsOutput('')).toBeNull();
  });
});
