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

  it('measures the exact JSON.stringify UTF-8 spelling, including escaped and lone-surrogate strings', () => {
    for (const value of [
      'plain',
      'é',
      'quote " slash \\ newline\n',
      '\uD800',
      { 'key\uD800': ['é', 'quote " slash \\ newline\n'] },
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

    for (const value of [sparse, accessor, new Date(), undefined, Number.NaN, Infinity, 1n]) {
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
});
