import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector/promises';
import { describe, expect, it, vi } from 'vitest';

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
  it('compares admitted native optional members without normalizing either value again', () => {
    const left = { child: { value: 1, optional: undefined }, rows: [{ optional: undefined }] };
    const right = { rows: [{}], child: { value: 1 } };
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    let results: boolean[];
    let walks: number;
    try {
      results = [
        sameStrictJsonValue(left, right, { omitUndefinedObjectMembers: true }),
        sameStrictJsonValue(right, left, { omitUndefinedObjectMembers: true }),
        sameStrictJsonValue(left, right),
        sameStrictJsonValue(left, { ...right, child: { value: 1, optional: null } }, { omitUndefinedObjectMembers: true }),
      ];
      walks = descriptors.mock.calls.length;
    } finally { descriptors.mockRestore(); }
    expect(results).toEqual([true, true, false, false]);
    expect(walks).toBe(0);
  });

  it('compares wide retained Usage curves without allocating one pending pair per value', async () => {
    const left = Array.from({ length: 45_000 }, (_, index) => ({ observedAtMs: index, usedFraction: index / 45_000 }));
    const right = left.map(point => ({ usedFraction: point.usedFraction, observedAtMs: point.observedAtMs }));
    const repetitions = 20;
    const bytes = Buffer.byteLength(JSON.stringify(left));
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    let equal = true;
    try {
      for (let repeat = 0; repeat < repetitions; repeat++) equal &&= sameStrictJsonValue(left, right);
      const { profile } = await session.post('HeapProfiler.stopSampling');
      const sum = (node: typeof profile.head): number => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      const allocatedBytes = sum(profile.head);
      console.info(JSON.stringify({ comparator: '45k curves', repetitions, encodedBytes: bytes, allocatedBytes }));
      expect(equal).toBe(true);
      // This allocation regression budget covers key enumeration for both
      // inputs. It excludes the reproduced per-child pending-pair copies.
      expect(allocatedBytes).toBeLessThan(bytes * repetitions * 4);
    } finally { session.disconnect(); }
  });

  it('preserves primitive, missing-key, array-order and deep non-recursive equality', () => {
    for (const value of [null, true, false, 0, 'value', undefined]) expect(sameStrictJsonValue(value, value)).toBe(true);
    for (const [left, right] of [[null, {}], [[], {}], [[1], [1, 2]], [{ a: 1 }, { b: 1 }], [0, '0'], [false, 0]]) {
      expect(sameStrictJsonValue(left, right)).toBe(false);
    }
    expect(sameStrictJsonValue(nested(12_000), nested(12_000))).toBe(true);
    const earlier = [{ at: 1, value: null }, { at: 2, value: 0 }];
    expect(sameStrictJsonValue(earlier, [{ at: 1, value: 0 }, { at: 2, value: 0 }])).toBe(false);
    expect(sameStrictJsonValue(earlier, [...earlier].reverse())).toBe(false);
  });

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
