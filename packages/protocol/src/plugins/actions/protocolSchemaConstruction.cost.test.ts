import { expect, it, vi } from 'vitest';

import * as strictJson from '../contributions/strictJsonValue.js';
import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from './protocolComposableSchema.js';

it('constructs unused parser trees without constructing strict JSON schema documents', () => {
  // Call-through observation of the real owner; no validator is replaced.
  const clones = vi.spyOn(strictJson, 'cloneStrictPluginJsonValue');
  try {
    const schemas = Array.from({ length: 100 }, () => defineProtocolObject({
      name: defineProtocolString({ minLength: 1 }),
      state: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('closed')]),
      tags: defineProtocolArray(defineProtocolString()).optional(),
    }, { policy: 'closed' }));
    const documentConstructions = () => clones.mock.calls.filter(([, path]) => path === 'schema').length;
    console.info('unused-protocol-schema-documents', documentConstructions());
    expect(documentConstructions()).toBe(0);
    const schema = schemas[0]!;
    expect(schema.parse({ name: 'first', state: 'open' })).toEqual({ name: 'first', state: 'open' });
    expect(schema.safeParse({ name: 'first', state: 'open', extra: true }).success).toBe(false);
    expect(schema.safeParse({ name: 'first', state: 'invalid' }).success).toBe(false);
    expect(documentConstructions()).toBe(0);
    const projection = schema.jsonSchema;
    // Public documents cross structured-clone boundaries during Zod projection.
    expect(structuredClone(projection)).toEqual(projection);
    expect(Object.keys(projection)).toContain('properties');
    const afterFirstRead = documentConstructions();
    expect(afterFirstRead).toBeGreaterThan(0);
    expect(schema.jsonSchema).toBe(projection);
    expect(documentConstructions()).toBe(afterFirstRead);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(projection.properties?.tags?.items?.type).toBe('string');
  } finally {
    clones.mockRestore();
  }
});
