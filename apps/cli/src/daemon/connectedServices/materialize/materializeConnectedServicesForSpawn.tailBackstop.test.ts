import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceMaterializationTailStuckError,
  runSerializedMaterialization,
} from './materializeConnectedServicesForSpawn';

describe('materialization root-tail backstop (RR-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds a joiner behind a never-settling predecessor and self-heals the queue', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-materialize-tail-backstop-'));

    // Predecessor that never settles: a pathological leaf that escaped its own bounds.
    const stuck = runSerializedMaterialization(rootDir, () => new Promise<never>(() => {}));
    void stuck.catch(() => {});

    // A joiner must NOT wait forever: it fails loudly with the typed backstop error.
    const joiner = runSerializedMaterialization(rootDir, async () => 'joined');
    const joinerOutcome = joiner.then(
      () => 'resolved' as const,
      (error: unknown) => (error instanceof ConnectedServiceMaterializationTailStuckError ? 'backstopped' as const : 'other' as const),
    );
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 1_000);
    expect(await joinerOutcome).toBe('backstopped');

    // The stuck tail was dropped from the map: a FRESH attempt proceeds immediately.
    const fresh = runSerializedMaterialization(rootDir, async () => 'fresh');
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 1_000);
    await expect(fresh).resolves.toBe('fresh');
  });

  it('keeps normal serialization intact (second segment runs after the first settles)', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-materialize-tail-order-'));
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = runSerializedMaterialization(rootDir, async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });
    const second = runSerializedMaterialization(rootDir, async () => {
      order.push('second');
    });
    await vi.advanceTimersByTimeAsync(10);
    releaseFirst();
    await first;
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
