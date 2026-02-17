import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  return Object.values(record).some((v) => hasKeyDeep(v, key));
}

describe('actionInputElevenLabsToolSchema', () => {
  it('produces an ElevenLabs-compatible parameters schema for review.start', async () => {
    const spec = getActionSpec('review.start');
    const { actionSpecToElevenLabsClientToolParameters } = await import('./actionInputElevenLabsToolSchema.js');

    const schema = actionSpecToElevenLabsClientToolParameters(spec);

    expect(schema).toMatchObject({
      type: 'object',
      properties: expect.any(Object),
    });

    // ElevenLabs client tool parameters do not accept JSON-schema `additionalProperties` or unions like `oneOf`.
    expect(hasKeyDeep(schema, 'additionalProperties')).toBe(false);
    expect(hasKeyDeep(schema, 'oneOf')).toBe(false);
    expect(hasKeyDeep(schema, 'anyOf')).toBe(false);
    expect(hasKeyDeep(schema, 'allOf')).toBe(false);

    // Leaf parameter schemas must include descriptions (ElevenLabs validates this).
    const sessionId = (schema as any).properties?.sessionId;
    expect(sessionId).toMatchObject({ type: 'string' });
    expect(typeof sessionId.description).toBe('string');

    const engineIds = (schema as any).properties?.engineIds;
    expect(engineIds).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(typeof engineIds.description).toBe('string');
    expect(typeof engineIds.items?.description).toBe('string');

    const base = (schema as any).properties?.base;
    expect(base?.type).toBe('object');
    expect(base?.properties?.kind).toMatchObject({ type: 'string' });
    expect(base?.properties?.kind?.enum).toEqual(expect.arrayContaining(['none', 'branch', 'commit']));
  });
});
