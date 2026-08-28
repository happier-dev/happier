import { describe, expect, it } from 'vitest';

import {
  runSerializedMaterialization,
  runSerializedMaterializationPromotion,
} from './materializeConnectedServicesForSpawn';

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function expectSameRootSerialization(
  run: (root: string, work: () => Promise<string>) => Promise<string>,
): Promise<void> {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const order: string[] = [];
  const first = run('/materialized/same-root', async () => {
    order.push('first:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push('first:end');
    return 'first';
  });
  await firstStarted.promise;

  let secondSettled = false;
  const second = run('/materialized/same-root', async () => {
    order.push('second:start');
    return 'second';
  }).finally(() => {
    secondSettled = true;
  });
  await Promise.resolve();

  expect(secondSettled).toBe(false);
  expect(order).toEqual(['first:start']);
  releaseFirst.resolve();
  await expect(first).resolves.toBe('first');
  await expect(second).resolves.toBe('second');
  expect(order).toEqual(['first:start', 'first:end', 'second:start']);
}

describe('connected-service materialization atomicity', () => {
  it('serializes same-root materialization work', async () => {
    await expectSameRootSerialization(runSerializedMaterialization);
  });

  it('serializes same-root promotion work', async () => {
    await expectSameRootSerialization(runSerializedMaterializationPromotion);
  });
});
