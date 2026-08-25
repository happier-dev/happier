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
  it('accepts valid deep JSON without imposing a traversal-depth quota', () => {
    const deep = nested(12_000);

    expect(() => cloneStrictPluginJsonValue(deep, 'value')).not.toThrow();
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

  it('rejects accessors without reading them, rejects invalid values, and returns frozen snapshots', () => {
    const sparse = new Array<unknown>(1);
    const extraArrayProperty = Object.assign([1], { extra: 'must-not-be-dropped' });
    const accessor = { stable: true } as Record<string, unknown>;
    let accessorReads = 0;
    Object.defineProperty(accessor, 'unsafe', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'read once';
      },
    });
    let elementReads = 0;
    const accessorElement: unknown[] = [];
    Object.defineProperty(accessorElement, '0', {
      enumerable: true,
      configurable: true,
      get() {
        elementReads += 1;
        return 'read once';
      },
    });

    const cyclic = { self: null as unknown };
    cyclic.self = cyclic;
    expect(() => cloneStrictPluginJsonValue(accessor, 'value')).toThrow();
    expect(accessorReads).toBe(0);
    // An array element is the other half of "validation must not run code":
    // the owner reaches it through the array descriptor path, not the member
    // path above, so a zero read count has to be proven on both.
    expect(Array.isArray(accessorElement)).toBe(true);
    expect(() => cloneStrictPluginJsonValue(accessorElement, 'value')).toThrow();
    expect(elementReads).toBe(0);
    let throwingAccessorReads = 0;
    const throwingAccessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throwingAccessorReads += 1;
        throw new Error('author getter failed');
      },
    });

    // `extraArrayProperty` clones into a dense `[1]`, silently dropping the
    // member the author wrote, unless the owner refuses it outright.
    for (const value of [
      sparse,
      extraArrayProperty,
      throwingAccessor,
      undefined,
      Number.NaN,
      Infinity,
      1n,
      cyclic,
    ]) {
      expect(() => cloneStrictPluginJsonValue(value, 'value')).toThrow();
    }
    // The throwing accessor must be rejected from its descriptor. A zero read
    // count is what separates "this owner refused an accessor" from "the
    // author's getter ran and happened to throw".
    expect(throwingAccessorReads).toBe(0);

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

  it('rejects non-plain object and array prototypes', () => {
    class AuthoredRecord {
      readonly label = 'must-not-cross-the-boundary';
    }
    const authored = [true];
    Object.setPrototypeOf(authored, {
      customArrayMethod() {
        return 'must-not-cross-the-boundary';
      },
    });

    expect(Array.isArray(authored)).toBe(true);
    expect(() => cloneStrictPluginJsonValue(authored, 'value')).toThrow();
    expect(() => cloneStrictPluginJsonValue(
      Object.assign(Object.create({ inherited: true }), { own: 'value' }),
      'value',
    )).toThrow();
    // A `Date` carries no own keys at all, so an owner that inspected only own
    // properties would accept it and silently normalize it into `{}` - the
    // value would become different JSON than the author wrote.
    expect(() => cloneStrictPluginJsonValue(new Date(0), 'value')).toThrow();
    // A class prototype carries no enumerable own member, so an owner that
    // rejected only prototypes with enumerable properties would accept this.
    expect(() => cloneStrictPluginJsonValue(new AuthoredRecord(), 'value')).toThrow();
    // The positive twin: this owner's own output is null-prototype, so
    // re-admitting an already normalized value must keep working.
    const nullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { own: 'value' },
    );

    expect(cloneStrictPluginJsonValue(nullPrototype, 'value')).toEqual({ own: 'value' });
  });

  it('preserves lone UTF-16 surrogates for JSON.stringify and rejects Array subclasses', () => {
    class ExtendedArray extends Array<unknown> {}

    const value = { '\uDC00': '\uD800' };
    const cloned = cloneStrictPluginJsonValue(value, 'value');

    expect(cloned).toEqual(value);
    expect(measureSerializedStrictPluginJsonUtf8Bytes(cloned, 'value'))
      .toBe(serializedUtf8Bytes(value));
    expect(() => cloneStrictPluginJsonValue(new ExtendedArray('value'), 'value')).toThrow();
  });
});
