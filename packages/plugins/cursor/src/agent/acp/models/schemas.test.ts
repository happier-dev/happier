import { describe, expect, it } from 'vitest';

import { cursorListAvailableModelsResponseSchema } from './schemas.js';

describe('Cursor available-model schemas', () => {
  it('preserves exact opaque model, config, and choice identifiers and strips extras', () => {
    expect(cursorListAvailableModelsResponseSchema.parse({
      models: [{
        value: ' model-a\n ',
        name: 'Model A',
        secret: 'strip',
        configOptions: [{
          id: ' effort ',
          name: 'Effort',
          category: ' model_config ',
          type: 'select',
          currentValue: ' high ',
          options: [{ value: ' high ', name: 'High', secret: 'strip' }],
        }],
      }],
    })).toEqual({
      models: [{
        value: ' model-a\n ',
        name: 'Model A',
        configOptions: [{
          id: ' effort ',
          name: 'Effort',
          category: ' model_config ',
          type: 'select',
          currentValue: ' high ',
          options: [{ value: ' high ', name: 'High' }],
        }],
      }],
    });
  });

  it('rejects malformed non-select options and bounded model overflow', () => {
    expect(cursorListAvailableModelsResponseSchema.safeParse({
      models: [{ value: 'a', name: 'A', configOptions: [{ id: 'x', name: 'X', type: 'boolean' }] }],
    }).success).toBe(false);
    expect(cursorListAvailableModelsResponseSchema.safeParse({
      models: Array.from({ length: 513 }, (_, index) => ({ value: `m-${index}`, name: `M ${index}` })),
    }).success).toBe(false);
  });
});
