import { describe, expect, it } from 'vitest';

import fixture from './fixtures/catalog.json';
import { parseVercelModels } from './vercelModelsParser.js';

describe('Vercel AI Gateway catalog', () => {
  it('keeps language models and maps only explicitly advertised reasoning levels', () => {
    const { models } = parseVercelModels(fixture);
    expect(models.map(model => model.id)).toEqual(['openai/gpt-5', 'anthropic/claude-sonnet-4', 'vmc/team-model']);
    expect(models[0]).toMatchObject({
      name: 'GPT-5', contextWindowTokens: 400000,
      capabilities: { toolRoundTrips: 'supported', reasoningControls: 'supported' },
      modelOptions: [{ id: 'reasoning_effort', type: 'select', currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }, { value: 'max', name: 'Max' }] }],
    });
    // A budget/toggle is not an effort level, and a reasoning tag alone must not invent controls.
    expect(models[1]?.modelOptions).toBeUndefined();
    expect(models[2]?.modelOptions).toBeUndefined();
    expect(models[2]?.capabilities?.reasoningControls).toBe('unknown');
  });

  it('rejects malformed catalog framing and language rows rather than silently emptying the catalog', () => {
    for (const body of [{}, { data: null }, { data: [{ type: 'language' }] },
      { data: [{ type: 'language', id: 'broken', context_window: -1 }] }]) {
      expect(() => parseVercelModels(body)).toThrow(TypeError);
    }
    expect(parseVercelModels({ data: [] }).models).toEqual([]);
  });

  it('projects 1,000 models with one row-kind read per catalog entry', () => {
    let reads = 0;
    const data = Array.from({ length: 1000 }, (_, i) => ({ get type() { reads++; return 'language'; }, id: `vmc/model-${i}` }));
    expect(parseVercelModels({ data }).models).toHaveLength(1000);
    expect(reads).toBe(1000);
  });
});
