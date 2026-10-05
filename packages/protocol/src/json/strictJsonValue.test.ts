import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { normalizeStrictJsonValue, projectNativeJsonValueForTransport, sameStrictJsonValue } from './strictJsonValue.js';

function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let index = 0; index < depth; index += 1) {
    value = { next: value };
  }
  return value;
}

describe('normalizeStrictJsonValue', () => {
  it('delegates deep immutable cloning without imposing traversal quotas', () => {
    const authored = nested(12_000);
    let normalized: ReturnType<typeof normalizeStrictJsonValue> | undefined;

    expect(() => {
      normalized = normalizeStrictJsonValue(authored);
    }).not.toThrow();
    if (normalized === undefined) throw new Error('Expected normalized strict JSON');

    expect(normalized === authored).toBe(false);
    expect(Object.isFrozen(normalized)).toBe(true);
    let terminal: unknown = normalized;
    for (let index = 0; index < 12_000; index += 1) {
      terminal = (terminal as { next: unknown }).next;
    }
    expect(terminal).toBe('leaf');
  });

  it('does not apply the Agent Runtime byte ceiling to generic strict JSON', () => {
    const value = 'x'.repeat(1_024 * 1_024);

    expect(normalizeStrictJsonValue(value)).toBe(value);
  });
});

describe('native JSON transport projection', () => {
  it('omits optional native object members without weakening strict JSON admission', () => {
    const native = { absent: undefined, nested: { present: null, optional: undefined }, items: ['value'] };
    expect(projectNativeJsonValueForTransport(native)).toEqual({ nested: { present: null }, items: ['value'] });
    expect(() => normalizeStrictJsonValue(native)).toThrow();
    for (const value of [undefined, [undefined], { value: () => 1 }, { value: Symbol('value') }, { value: Number.NaN }, new Date()]) {
      expect(() => projectNativeJsonValueForTransport(value)).toThrow();
    }
    const withAccessor = { get value() { throw new Error('Accessor invoked'); } };
    expect(() => projectNativeJsonValueForTransport(withAccessor)).toThrow('enumerable data property');
  });
});

describe('strict JSON vocabulary ownership', () => {
  it('keeps recursive types and the normalizing schema at the canonical owner', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const offenders: string[] = [];
    const pending = [sourceRoot];

    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test')) continue;
        if (relative(sourceRoot, path) === 'json/strictJsonValue.ts') continue;
        const source = readFileSync(path, 'utf8');
        if (
          /\btype\s+StrictJsonValue\s*=/.test(source)
          || /\binterface\s+StrictJsonObject\b/.test(source)
          || /\b(?:const|let|var)\s+StrictJsonValueSchema\s*=/.test(source)
        ) {
          offenders.push(relative(sourceRoot, path));
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});

describe('sameStrictJsonValue', () => {
  it('compares strict JSON semantically rather than by object insertion order', () => {
    const left = normalizeStrictJsonValue({ nested: { a: 1, b: 2 }, items: ['x', null] });
    const right = normalizeStrictJsonValue({ items: ['x', null], nested: { b: 2, a: 1 } });

    expect(sameStrictJsonValue(left, right)).toBe(true);
    expect(sameStrictJsonValue(left, normalizeStrictJsonValue({
      items: [null, 'x'],
      nested: { a: 1, b: 2 },
    }))).toBe(false);
  });
});
