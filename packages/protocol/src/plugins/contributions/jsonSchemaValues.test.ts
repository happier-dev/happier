import { describe, expect, it } from 'vitest';

import { pluginJsonValuesEqual } from './jsonSchemaValues';

describe('pluginJsonValuesEqual', () => {
  it('compares 12,000-level strict JSON without recursive stack failure', () => {
    const createDeepValue = (terminal: string): unknown => {
      let value: unknown = terminal;
      for (let index = 0; index < 12_000; index += 1) {
        value = { next: value };
      }
      return value;
    };

    const left = createDeepValue('same');

    expect(pluginJsonValuesEqual(left, createDeepValue('same'))).toBe(true);
    expect(pluginJsonValuesEqual(left, createDeepValue('different'))).toBe(false);
  });

  it('compares nested null-prototype JSON independently of object key order', () => {
    const left = Object.assign(Object.create(null) as Record<string, unknown>, {
      second: [Object.assign(Object.create(null) as Record<string, unknown>, { enabled: true })],
      first: 4,
    });
    const right = { first: 4, second: [{ enabled: true }] };

    expect(pluginJsonValuesEqual(left, right)).toBe(true);
    expect(pluginJsonValuesEqual(right, left)).toBe(true);
  });

  it('accepts shared acyclic values as structural JSON', () => {
    const shared = { enabled: true };

    expect(pluginJsonValuesEqual(
      { first: shared, second: shared },
      { first: { enabled: true }, second: { enabled: true } },
    )).toBe(true);
  });

  it('uses finite JSON number semantics and keeps arrays ordered', () => {
    expect(pluginJsonValuesEqual(-0, 0)).toBe(true);
    expect(pluginJsonValuesEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
    expect(pluginJsonValuesEqual(Number.NaN, Number.NaN)).toBe(false);
    expect(pluginJsonValuesEqual([1, 2], [2, 1])).toBe(false);
  });

  it('does not equate values outside the strict JSON data model', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(pluginJsonValuesEqual(undefined, undefined)).toBe(false);
    expect(pluginJsonValuesEqual(new Date(0), {})).toBe(false);
    expect(pluginJsonValuesEqual([, 1], [undefined, 1])).toBe(false);
    expect(pluginJsonValuesEqual(cyclic, cyclic)).toBe(false);
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
