import { describe, expect, it } from 'vitest';

import { PluginJsonSchemaV2Schema } from '../contributions/jsonSchema.js';
import { compileProtocolJsonSchema } from './jsonSchemaCompiler.js';
import { compilePluginJsonSchema } from './jsonSchemaValidation.js';

describe('compiled declarative value constraints', () => {
  it('enforces an admitted plugin scalar constraint', () => {
    const schema = {
      type: 'number',
      'x-happier-value-constraints': [{ kind: 'less_than', left: { path: [] }, right: { value: 5 } }],
    };
    expect(PluginJsonSchemaV2Schema.safeParse(schema).success).toBe(true);
    const validate = compilePluginJsonSchema(schema);
    expect(validate(4)).toBe(true);
    expect(validate(5)).toBe(false);
    expect(validate(10)).toBe(false);
  });

  it.each(['draft-07', 'draft-2020-12'] as const)(
    'enforces conditional wildcard comparisons in nested %s schemas', dialect => {
      const validate = compileProtocolJsonSchema({
        type: 'object',
        properties: { payload: {
          type: 'object',
          'x-happier-value-constraints': [{
            kind: 'less_than', left: { path: ['items', '*'] }, right: { path: ['limit'] },
            when: { path: ['enabled'], equals: true },
          }],
        } },
      }, dialect);
      expect(validate({ payload: { enabled: true, items: [1, 4], limit: 5 } })).toBe(true);
      expect(validate({ payload: { enabled: false, items: [10], limit: 5 } })).toBe(true);
      expect(validate({ payload: { enabled: true, items: [1, 5], limit: 5 } })).toBe(false);
      expect(validate({ payload: { enabled: true, items: [1, 10], limit: 5 } })).toBe(false);
      expect(validate({ payload: { enabled: true, items: [1] } })).toBe(false);
    },
  );

  it.each(['draft-07', 'draft-2020-12'] as const)(
    'enforces Unicode character length multiples in %s schemas', dialect => {
      const validate = compileProtocolJsonSchema({ type: 'string', 'x-happier-length-multiple-of': 2 }, dialect);
      expect(validate('😀é')).toBe(true);
      expect(validate('😀')).toBe(false);
      expect(validate('abc')).toBe(false);
    },
  );
});
