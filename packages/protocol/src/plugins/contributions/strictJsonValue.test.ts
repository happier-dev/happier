import { describe, expect, it } from 'vitest';

import {
  cloneStrictPluginJsonValue,
  measureSerializedStrictPluginJsonUtf8Bytes,
} from './strictJsonValue.js';

function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    value = { next: value };
  }
  return value;
}

function serializedUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Expected a JSON-serializable value');
  return new TextEncoder().encode(serialized).byteLength;
}

describe('cloneStrictPluginJsonValue', () => {
  it('accepts valid deep ordinary JSON without imposing a public traversal quota', () => {
    const value = nested(12_000);

    expect(() => cloneStrictPluginJsonValue(value, 'value')).not.toThrow();
  });

  it('measures the exact JSON.stringify UTF-8 spelling', () => {
    for (const value of [
      'plain',
      'é',
      'quote " slash \\ newline\n',
      { key: ['é', 'quote " slash \\ newline\n'] },
    ]) {
      const cloned = cloneStrictPluginJsonValue(value, 'value');

      expect(measureSerializedStrictPluginJsonUtf8Bytes(cloned, 'value'))
        .toBe(serializedUtf8Bytes(value));
    }
  });

  it('rejects non-JSON data without invoking accessors and returns frozen snapshots', () => {
    const sparse = new Array<unknown>(1);
    const accessor = { stable: true } as Record<string, unknown>;
    let accessorReads = 0;
    Object.defineProperty(accessor, 'unsafe', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'must not run';
      },
    });

    const cyclic = { self: null as unknown };
    cyclic.self = cyclic;
    for (const value of [sparse, accessor, new Date(), undefined, Number.NaN, Infinity, 1n, cyclic]) {
      expect(() => cloneStrictPluginJsonValue(value, 'value')).toThrow();
    }
    expect(accessorReads).toBe(0);

    const authored = { nested: ['before'] };
    const cloned = cloneStrictPluginJsonValue(authored, 'value') as { nested: string[] };
    authored.nested[0] = 'after';

    expect(cloned).toEqual({ nested: ['before'] });
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(Object.isFrozen(cloned.nested)).toBe(true);
  });

  it('rejects symbol and non-enumerable own properties instead of silently dropping them', () => {
    const withSymbol = Object.defineProperty({}, Symbol('hidden'), {
      enumerable: true,
      value: 'must-not-be-dropped',
    });
    const withNonEnumerable = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: 'must-not-be-dropped',
    });

    expect(() => cloneStrictPluginJsonValue(withSymbol, 'value')).toThrow();
    expect(() => cloneStrictPluginJsonValue(withNonEnumerable, 'value')).toThrow();
  });

  it('rejects arrays with an inherited custom prototype rather than normalizing their identity away', () => {
    const authored = [true];
    Object.setPrototypeOf(authored, {
      customArrayMethod() {
        return 'must-not-cross-the-boundary';
      },
    });

    expect(Array.isArray(authored)).toBe(true);
    expect(() => cloneStrictPluginJsonValue(authored, 'value')).toThrow();
  });

  it('preserves lone UTF-16 surrogates for JSON.stringify while rejecting Array subclasses', () => {
    class ExtendedArray extends Array<unknown> {}

    const value = { '\uDC00': '\uD800' };
    const cloned = cloneStrictPluginJsonValue(value, 'value');

    expect(cloned).toEqual(value);
    expect(measureSerializedStrictPluginJsonUtf8Bytes(cloned, 'value'))
      .toBe(serializedUtf8Bytes(value));
    expect(() => cloneStrictPluginJsonValue(new ExtendedArray('value'), 'value')).toThrow();
  });
});
