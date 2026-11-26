import { describe, expect, it } from 'vitest';

import { formatCompactToolSignatureV1 } from './formatCompactToolSignatureV1.js';

describe('formatCompactToolSignatureV1', () => {
  it('shows required and optional properties, including nested arrays and local references', () => {
    const schema = {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        'result-kinds': { type: 'array', items: { $ref: '#/definitions/kind~1name' } },
      },
      definitions: { 'kind/name': { enum: ['file', 'issue'] } },
    };

    expect(formatCompactToolSignatureV1('lookup', schema))
      .toBe('lookup(args: { query: string; "result-kinds"?: Array<"file" | "issue"> }): Promise<unknown>');
  });

  it.each([
    { type: 'object', properties: { next: { $ref: '#' } } },
    { allOf: [{ type: 'string' }, { minLength: 3 }] },
    { $ref: 'https://example.test/schema' },
  ])('uses the generic signature for recursive or unsupported schemas (%j)', (schema) => {
    expect(formatCompactToolSignatureV1('lookup', schema))
      .toBe('lookup(args: Record<string, unknown>): Promise<unknown>');
  });
});
