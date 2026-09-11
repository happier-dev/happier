import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionUiE2eSpecs, parseUiE2eShard } from './select-ui-e2e-shard.mjs';

test('weighted UI E2E partition keeps slow files separate and assigns every spec once', () => {
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

test('UI E2E shard parsing rejects malformed and out-of-range selectors', () => {
  assert.deepEqual(parseUiE2eShard('3/18'), { current: 3, total: 18 });
  assert.throws(() => parseUiE2eShard('0/18'), /between 1 and 18/);
  assert.throws(() => parseUiE2eShard('19/18'), /between 1 and 18/);
  assert.throws(() => parseUiE2eShard('3'), /current\/total/);
});
