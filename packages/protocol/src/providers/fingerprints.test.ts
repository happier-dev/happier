import { describe, expect, it } from 'vitest';

import { canonicalizeFingerprintValue, createProviderFingerprintV1 } from './fingerprints.js';

describe('provider fingerprint encoder', () => {
  it('sorts object keys while preserving semantic array order', () => {
    const a = createProviderFingerprintV1('connection-security', { b: 2, a: 1, endpoints: ['a', 'b'] });
    const b = createProviderFingerprintV1('connection-security', { endpoints: ['a', 'b'], a: 1, b: 2 });
    const reordered = createProviderFingerprintV1('connection-security', { a: 1, b: 2, endpoints: ['b', 'a'] });
    expect(a).toBe(b);
    expect(reordered).not.toBe(a);
    expect(a).toMatch(/^connection-security:v1:[A-Za-z0-9_-]{43}$/);
  });

  it('normalizes only schema-declared sets and separates domains', () => {
    const input = canonicalizeFingerprintValue({ answers: ['::1', '127.0.0.1', '::1'] }, { setPaths: ['answers'] });
    expect(input).toEqual({ answers: ['127.0.0.1', '::1'] });
    expect(createProviderFingerprintV1('endpoint-set', input)).not.toBe(
      createProviderFingerprintV1('binding-security', input),
    );
  });

  it('has a fixed cross-runtime vector', () => {
    expect(createProviderFingerprintV1('compatibility', { protocol: 'openai-responses', required: ['streaming'] }))
      .toBe('compatibility:v1:BwxIG6yZ9slMKmxf6wEX3ZYgGh_IrYLMWbeHbAGHs6I');
  });

  it('canonicalizes own prototype-named object keys without mutating object prototypes', () => {
    const input = Object.fromEntries([['__proto__', 'value'], ['constructor', 'other']]);
    const canonical = canonicalizeFingerprintValue(input);
    expect(Object.prototype.hasOwnProperty.call(canonical, '__proto__')).toBe(true);
    expect(createProviderFingerprintV1('catalog', input)).toMatch(/^catalog:v1:/);
  });

  it('rejects non-JSON objects, accessors, symbols, sparse arrays, and extra array properties', () => {
    class Example { readonly value = 1; }
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    const withSymbol = { value: 1 } as Record<PropertyKey, unknown>;
    withSymbol[Symbol('hidden')] = 2;
    const sparse = new Array<unknown>(2);
    sparse[1] = null;
    const extra = [null] as unknown[] & { extra?: string };
    extra.extra = 'ignored-by-json';

    for (const value of [new Date(0), new Map(), new Set(), new Example(), accessor, withSymbol, sparse, extra]) {
      expect(() => createProviderFingerprintV1('catalog', value)).toThrowError(/canonical JSON/u);
    }
    expect(createProviderFingerprintV1('catalog', Object.create(null))).toMatch(/^catalog:v1:/);
    expect(createProviderFingerprintV1('catalog', [null, null])).toMatch(/^catalog:v1:/);
  });

  it('rejects cycles with a bounded domain error while allowing repeated non-cyclic references', () => {
    const objectCycle: Record<string, unknown> = {};
    objectCycle.self = objectCycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    for (const value of [objectCycle, arrayCycle]) {
      expect(() => createProviderFingerprintV1('catalog', value)).toThrowError(/canonical JSON/u);
    }

    const shared = { value: 1 };
    expect(createProviderFingerprintV1('catalog', [shared, shared])).toBe(
      createProviderFingerprintV1('catalog', [{ value: 1 }, { value: 1 }]),
    );
  });
});
