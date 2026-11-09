import { describe, expect, it, vi } from 'vitest';

import {
  assertStrictPluginJsonValue,
  cloneStrictPluginJsonValue,
  cloneStrictPluginJsonValueWithTraversalLimits,
  measureSerializedStrictPluginJsonUtf8Bytes,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
  measurePluginJsonUtf8Bytes,
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
  it('walks external data once, then reuses its immutable proof through nested boundary checks', () => {
    const input = { identity: { pluginId: 'acme.count' }, values: [1, 2] };
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    try {
      const admitted = cloneStrictPluginJsonValue(input, 'external');
      expect(descriptors.mock.calls.length).toBe(3);
      descriptors.mockClear();
      const wrappers: unknown[] = [];
      for (let index = 0; index < 100; index += 1) {
        assertStrictPluginJsonValue(admitted, 'verified');
        wrappers.push(cloneStrictPluginJsonValue({ payload: admitted }, 'wrapper'));
      }
      // Only the new untrusted wrapper is visited on each boundary crossing;
      // the admitted subtree is never walked again (including assertion-only reads).
      expect(descriptors.mock.calls.length).toBe(100);
      for (const wrapper of wrappers) expect(Reflect.get(wrapper as object, 'payload')).toBe(admitted);
      input.values.push(3);
      const changed = cloneStrictPluginJsonValue(input, 'external');
      expect(changed).toMatchObject({ values: [1, 2, 3] });
      expect(admitted).toMatchObject({ values: [1, 2] });
      console.info('R-C strict JSON admission counts', { initialObjects: 3, admittedRechecks: 100, admittedSubtreeWalks: 0 });
    } finally { descriptors.mockRestore(); }
  });

  it('reuses only its own deeply frozen snapshots without walking them again', () => {
    const authored = { identity: { pluginId: 'acme.agent', localId: 'review' }, values: [1, 2] };
    const normalized = cloneStrictPluginJsonValue(authored, 'catalog');
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    try {
      const before = performance.now();
      for (let index = 0; index < 1_000; index += 1) cloneStrictPluginJsonValue(authored, 'catalog');
      const unnormalizedMs = performance.now() - before;
      const unnormalizedWalks = descriptors.mock.calls.length;
      descriptors.mockClear();
      let sameIdentity = true;
      const after = performance.now();
      for (let index = 0; index < 1_000; index += 1) {
        const cloned = cloneStrictPluginJsonValue(normalized, 'option');
        sameIdentity = cloned === normalized && sameIdentity;
      }
      const normalizedMs = performance.now() - after;
      const walks = descriptors.mock.calls.length;
      console.info('FX84 strict JSON work', { iterations: 1_000, unnormalizedMs, unnormalizedWalks, normalizedMs, walks });
      expect(sameIdentity).toBe(true);
      expect(walks).toBe(0);
      // Frozen caller objects are not an admission proof: their children can mutate.
      const callerFrozen = Object.freeze({ identity: authored.identity });
      const copy = cloneStrictPluginJsonValue(callerFrozen, 'external');
      expect(copy).not.toBe(callerFrozen);
      authored.identity.localId = 'changed';
      expect(copy).toMatchObject({ identity: { localId: 'review' } });
      const invalidFrozen = Object.freeze({ value: undefined });
      expect(() => cloneStrictPluginJsonValue(invalidFrozen, 'external')).toThrow();
      expect(() => cloneStrictPluginJsonValueWithTraversalLimits(normalized, 'bounded', { maxDepth: 1, maxValues: 100 }))
        .toThrow('depth limit');
      expect(() => cloneStrictPluginJsonValueWithTraversalLimits(normalized, 'bounded', { maxDepth: 100, maxValues: 1 }))
        .toThrow('values limit');
    } finally { descriptors.mockRestore(); }
  });

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

  it('measures a Usage query without allocating an encoded buffer for each JSON token', () => {
    const value = { results: [{ accounting: { contributions: Array.from({ length: 128 }, (_, index) => ({
      id: `event-${index}`, observedAtMs: index, sessionId: 'session',
      tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: { reportedUsd: 0, estimatedUsd: 0.125, currency: 'USD' },
      label: 'é 中 😀 \ud800',
    })) } }] };
    const expected = serializedUtf8Bytes(value);
    const encoded = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'usageQuery')).toBe(expected);
      expect(encoded.mock.calls.length).toBe(0);
    } finally { encoded.mockRestore(); }
  });

  it('preserves Unicode byte counts and exact serialized overflow boundaries', () => {
    const text = Array.from({ length: 65_536 }, (_, index) => String.fromCharCode(index)).join('');
    const value = { [text]: [text, '\ud800', '\udc00', '😀', -0, 1e30, null, true] };
    const expected = serializedUtf8Bytes(value);
    expect(measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'value')).toBe(expected);
    expect(measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'value', expected)).toBe(expected);
    expect(measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'value', expected - 2)).toBe(expected - 1);
    for (const raw of ['', 'ASCII', 'é', '中', '😀', '\u0000']) {
      expect(measurePluginJsonUtf8Bytes(raw, 'raw')).toBe(new TextEncoder().encode(raw).byteLength);
    }
    for (const raw of ['\ud800', '\udc00', '\ud800x', 'x\udc00']) {
      expect(() => measurePluginJsonUtf8Bytes(raw, 'raw')).toThrow('well-formed Unicode');
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

  it('drops host-only non-enumerable symbol brands and rejects author-visible hidden properties', () => {
    const hostBrand = Symbol('host-brand');
    const withHostBrand = Object.defineProperty({ visible: 'value' }, hostBrand, {
      enumerable: false,
      value: true,
    });
    const brandedArray = Object.defineProperty(['value'], hostBrand, {
      enumerable: false,
      value: true,
    });
    const withEnumerableSymbol = Object.defineProperty({}, Symbol('hidden'), {
      enumerable: true,
      value: 'must-not-be-dropped',
    });
    const withNonEnumerable = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: 'must-not-be-dropped',
    });

    const clonedObject = cloneStrictPluginJsonValue(withHostBrand, 'value');
    const clonedArray = cloneStrictPluginJsonValue(brandedArray, 'value');

    expect(clonedObject).toEqual({ visible: 'value' });
    expect(Object.getOwnPropertySymbols(clonedObject as object)).toEqual([]);
    expect(clonedArray).toEqual(['value']);
    expect(Object.getOwnPropertySymbols(clonedArray as object)).toEqual([]);
    expect(() => cloneStrictPluginJsonValue(withEnumerableSymbol, 'value')).toThrow();
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
