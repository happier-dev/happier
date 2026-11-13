import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { ACTION_IDS } from './actionIds.js';
import { projectActionSchemaForToolAdvertisement } from './actionSpecSections.js';

describe('sectioned tool advertisement', () => {
  it.each(['definitions', '$defs'])('keeps root arguments while deferring %s grammar to discovery', keyword => {
    const source = { type: 'object', properties: {
      input: { $ref: `#/${keyword}/shape` },
      actionId: { type: 'string', enum: [...ACTION_IDS] },
      mode: { type: 'string', enum: ['read', 'write'] },
    }, required: ['input'], [keyword]: { shape: { type: 'object', properties: {
      secretField: { type: 'string' }, nested: { $ref: `#/${keyword}/shape` },
    }, required: ['secretField'] } }, default: { definitions: { literal: true }, $ref: 'literal' } };
    const before = JSON.stringify(source);
    const projected = projectActionSchemaForToolAdvertisement(source);
    expect(projected).toMatchObject({ type: 'object', properties: {
      input: { type: 'object' }, actionId: { type: 'string' }, mode: source.properties.mode,
    }, required: ['input'], default: source.default, description: expect.stringContaining('action_spec_get') });
    expect(projected[keyword]).toBeUndefined();
    expect((projected.properties as Record<string, Record<string, unknown>>).actionId.enum).toBeUndefined();
    expect(JSON.stringify(source)).toBe(before);
    const validate = new Ajv({ strict: false }).compile(projected);
    expect(validate({ input: { secretField: 'hello', nested: {} }, actionId: ACTION_IDS[0], mode: 'read' })).toBe(true);
    expect(validate({ input: 'wrong' })).toBe(false);
    // Catalog growth cannot add catalog ids or section bodies to the advertisement.
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(Buffer.byteLength(before));
  });
});
