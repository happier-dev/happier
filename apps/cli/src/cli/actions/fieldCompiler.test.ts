import { describe, expect, it } from 'vitest';
import { compileActionCliFieldsFromJsonSchema } from './fieldCompiler';

describe('union caller fields', () => {
  it.each(['anyOf', 'oneOf'])('projects %s arm fields without making branch-only fields globally required', keyword => {
    const fields = compileActionCliFieldsFromJsonSchema({ jsonSchema: {
      [keyword]: [
        { type: 'object', properties: { kind: { const: 'app' }, environments: { type: 'array', items: { type: 'object' } },
          value: { type: 'string' } }, required: ['kind', 'environments'] },
        { type: 'object', properties: { kind: { enum: ['skill', 'agent'] }, keys: { type: 'array', items: { type: 'string' } },
          value: { type: 'number' } }, required: ['kind'] },
      ],
    } });
    expect(fields.find(field => field.path === 'kind')).toMatchObject({ kind: 'enum', required: true, choices: ['app', 'skill', 'agent'] });
    expect(fields.find(field => field.path === 'environments')).toMatchObject({ kind: 'json', required: false });
    expect(fields.find(field => field.path === 'keys')).toMatchObject({ kind: 'string_list', required: false });
    expect(fields.find(field => field.path === 'value')).toMatchObject({ kind: 'json', required: false });
  });
});
