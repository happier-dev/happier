import { describe, expect, it } from 'vitest';

import { pluginJsonValuesEqual } from './jsonSchemaValues';

describe('pluginJsonValuesEqual', () => {
  it('compares nested null-prototype JSON independently of object key order', () => {
    const left = Object.assign(Object.create(null) as Record<string, unknown>, {
      second: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
      first: 4,
    });
    const right = { first: 4, second: [{ enabled: true }] };

    expect(pluginJsonValuesEqual(left, right)).toBe(true);
    expect(pluginJsonValuesEqual(right, left)).toBe(true);
  });

  it('uses finite JSON number semantics and keeps arrays ordered', () => {
    expect(pluginJsonValuesEqual(-0, 0)).toBe(true);
    expect(pluginJsonValuesEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
    expect(pluginJsonValuesEqual(Number.NaN, Number.NaN)).toBe(false);
    expect(pluginJsonValuesEqual([1, 2], [2, 1])).toBe(false);
  });

  it('does not equate values outside the strict JSON data model', () => {
    expect(pluginJsonValuesEqual(undefined, undefined)).toBe(false);
    expect(pluginJsonValuesEqual(new Date(0), {})).toBe(false);
    expect(pluginJsonValuesEqual([, 1], [undefined, 1])).toBe(false);
  });

  it('rejects accessor-backed values without invoking their accessors', () => {
    let reads = 0;
    const hostile = { enabled: true } as Record<string, unknown>;
    Object.defineProperty(hostile, 'valueOf', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('accessor must not execute');
      },
    });

    expect(pluginJsonValuesEqual(hostile, { valueOf: 'literal', enabled: true })).toBe(false);
    expect(reads).toBe(0);
  });
});
