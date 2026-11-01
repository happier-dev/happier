import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSerializedMaterialization } from './materializeConnectedServicesForSpawn';

describe('materialization root-tail lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps queued work pending until a slow live predecessor settles, without admitting a later overlapping writer', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-materialize-tail-backstop-'));

    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const order: string[] = [];
    const first = runSerializedMaterialization(rootDir, async () => {
      order.push('first:start');
      firstStarted();
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      order.push('first:end');
    });
    await started;
    let settled = false;
    const joiner = runSerializedMaterialization(rootDir, async () => { order.push('second'); });
    const outcome = joiner.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 1_000);
    const third = runSerializedMaterialization(rootDir, async () => { order.push('third'); });
    await vi.advanceTimersByTimeAsync(1);
    try {
      expect(settled).toBe(false);
      expect(order).toEqual(['first:start']);
    } finally {
      releaseFirst();
      await Promise.all([first, outcome, third]);
    }
    await expect(joiner).resolves.toBeUndefined();
    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });

});
