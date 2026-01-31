import test from 'node:test';
import assert from 'node:assert/strict';
import { planPathSlices } from './slices.mjs';

test('planPathSlices returns empty for no paths', () => {
  assert.deepEqual(planPathSlices({ changedPaths: [], maxFiles: 3 }), []);
});

test('planPathSlices creates a single slice when under maxFiles', () => {
  const slices = planPathSlices({
    changedPaths: ['expo-app/a.txt', 'cli/b.txt', 'server/c.txt'],
    maxFiles: 10,
  });
  assert.equal(slices.length, 1);
  assert.deepEqual(slices[0].paths, ['cli/b.txt', 'expo-app/a.txt', 'server/c.txt']);
});

test('planPathSlices splits large groups by prefix depth and respects maxFiles', () => {
  const changedPaths = [
    ...Array.from({ length: 6 }, (_, i) => `expo-app/sources/a${i}.ts`),
    ...Array.from({ length: 6 }, (_, i) => `expo-app/sources/b${i}.ts`),
    ...Array.from({ length: 2 }, (_, i) => `cli/src/x${i}.ts`),
  ];
  const slices = planPathSlices({ changedPaths, maxFiles: 5, maxPrefixDepth: 4 });
  assert.ok(slices.length > 1);
  for (const s of slices) {
    assert.ok(s.paths.length <= 5, `slice ${s.label} exceeded maxFiles`);
  }
  const all = slices.flatMap((s) => s.paths).sort();
  assert.deepEqual(all, Array.from(new Set(changedPaths)).sort());
});

