import { describe, expect, it } from 'vitest';
import { getToolInputSchemaV2, getToolResultSchemaV2, KnownCanonicalToolNameV2Schema } from './index.js';
import { resolveToolMutationClassification } from '../toolMutationClassification.js';

describe('Script tool contract', () => {
  it('admits script cells and attributed results through the canonical tool catalog', () => {
    const name = KnownCanonicalToolNameV2Schema.parse('Script');
    const input = { code: 'return 2;', language: 'javascript', origin: 'native', cellId: 'cell-1' };
    const result = { output: 2, calls: [{ tool: 'lookup', status: 'denied', refusalCause: { code: 'permission_denied' } }] };
    expect(getToolInputSchemaV2(name).parse(input)).toEqual(input);
    expect(getToolResultSchemaV2(name).parse(result)).toEqual(result);
    expect(getToolResultSchemaV2(name).safeParse({ ...result, calls: [{ tool: 'lookup', status: 'guessed' }] }).success).toBe(false);
    expect(resolveToolMutationClassification(name)).toBe(resolveToolMutationClassification('Bash'));
  });
});
