import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  partitionUiE2eSpecs,
  parseUiE2eShard,
  planSelectedUiE2eShards,
} from './select-ui-e2e-shard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Reads the real flat spec inventory independently of the selector so the
// exhaustive-assignment assertion below cannot inherit the selector's own
// listing assumptions.
function listInventorySpecs() {
  const specDir = path.join(repoRoot, 'packages', 'tests', 'suites', 'ui-e2e');
  return fs.readdirSync(specDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => path.posix.join('packages/tests/suites/ui-e2e', entry.name));
}

test('weighted UI E2E partition keeps slow files on separate shards and assigns every spec once', () => {
  const specs = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts', 'e.spec.ts'];
  const partitions = partitionUiE2eSpecs({
    specs,
    shardTotal: 2,
    weights: new Map([
      ['a.spec.ts', 10],
      ['b.spec.ts', 9],
      ['c.spec.ts', 2],
      ['d.spec.ts', 1],
      ['e.spec.ts', 1],
    ]),
  });

  assert.deepEqual(partitions, [
    ['a.spec.ts', 'd.spec.ts', 'e.spec.ts'],
    ['b.spec.ts', 'c.spec.ts'],
  ]);
  assert.deepEqual(partitions.flat().sort(), specs);
  assert.notEqual(
    partitions.findIndex((partition) => partition.includes('a.spec.ts')),
    partitions.findIndex((partition) => partition.includes('b.spec.ts')),
  );
});

test('weighted UI E2E partition is deterministic and gives new specs the default weight', () => {
  const input = {
    specs: ['new-z.spec.ts', 'known.spec.ts', 'new-a.spec.ts'],
    shardTotal: 2,
    weights: new Map([['known.spec.ts', 5]]),
    defaultWeight: 2,
  };

  assert.deepEqual(partitionUiE2eSpecs(input), partitionUiE2eSpecs({
    ...input,
    specs: [...input.specs].reverse(),
  }));
});

test('union of all 18 shard outputs equals the current flat UI E2E spec inventory exactly once', () => {
  const specs = listInventorySpecs();
  assert.ok(
    specs.length >= 18,
    `UI E2E inventory has ${specs.length} specs; the 18-shard workflow needs at least 18`,
  );

  const partitions = partitionUiE2eSpecs({ specs, shardTotal: 18 });
  assert.equal(partitions.length, 18);
  const assigned = partitions.flat();
  assert.equal(new Set(assigned).size, assigned.length, 'every spec must be assigned at most once');
  assert.deepEqual(
    [...assigned].sort(),
    [...specs].sort(),
    'shard outputs must cover the current inventory exactly once',
  );
  for (const partition of partitions) {
    assert.ok(partition.length > 0, 'every workflow shard must receive at least one spec');
  }
});

test('UI E2E shard parsing rejects malformed and out-of-range selectors', () => {
  assert.deepEqual(parseUiE2eShard('3/18'), { current: 3, total: 18 });
  assert.throws(() => parseUiE2eShard('0/18'), /between 1 and 18/);
  assert.throws(() => parseUiE2eShard('19/18'), /between 1 and 18/);
  assert.throws(() => parseUiE2eShard('3'), /current\/total/);
});

test('a selected subset gets the share of the full shard count its measured weight takes', () => {
  const all = Array.from({ length: 36 }, (_, index) => `packages/tests/suites/ui-e2e/s${String(index).padStart(2, '0')}.spec.ts`);
  const weights = new Map([[all[0], 120 * 18]]);
  // The heavy spec alone takes 34% of the measured suite weight, but one spec cannot split.
  assert.deepEqual(planSelectedUiE2eShards({ selected: [all[0]], all, weights }), [[all[0]]]);
  const half = all.slice(1, 19);
  const shards = planSelectedUiE2eShards({ selected: half, all, weights });
  assert.equal(shards.length, 7); // ceil(18 * 2160 / 6360)
  assert.deepEqual(shards.flat().sort(), half);
  assert.deepEqual(planSelectedUiE2eShards({ selected: [], all, weights }), []);
});
