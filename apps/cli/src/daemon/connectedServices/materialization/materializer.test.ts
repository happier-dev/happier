import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createBestEffortCleanupDirectory,
} from './materializer';

describe('createBestEffortCleanupDirectory cleanup receipt', () => {
  async function makeMaterializedRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happier-cleanup-receipt-'));
    await writeFile(join(root, 'credential.material'), 'secret');
    return root;
  }

  it('settles its receipt only after the directory removal completes', async () => {
    const root = await makeMaterializedRoot();
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const remove = vi.fn(async () => {
      await removalGate;
      await rm(root, { recursive: true, force: true });
    });

    const cleanup = createBestEffortCleanupDirectory(root, remove);
    const receipt = cleanup();
    let settled = false;
    void Promise.resolve(receipt).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    releaseRemoval();
    await receipt;
    expect(remove).toHaveBeenCalledTimes(1);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('suppresses best-effort failures without latching them as success', async () => {
    let attempts = 0;
    const cleanup = createBestEffortCleanupDirectory('/virtual/root', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('busy');
    });

    await expect(cleanup()).resolves.toBeUndefined();
    await expect(cleanup()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('rejects a typed retryable failure when removal fails and completes on a retry', async () => {
    const root = await makeMaterializedRoot();
    let attempts = 0;
    const remove = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('EBUSY: materialized root busy');
      await rm(root, { recursive: true, force: true });
    });

    const cleanup = createBestEffortCleanupDirectory(
      root, remove, { failureMode: 'reject' },
    );
    await expect(cleanup()).rejects.toMatchObject({
      code: 'connected_service_materialized_cleanup_incomplete',
      message: 'Connected-service materialized directory cleanup did not complete',
    });

    await cleanup();
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent cleanup calls into one removal and stays idempotent after success', async () => {
    const root = await makeMaterializedRoot();
    const remove = vi.fn(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const cleanup = createBestEffortCleanupDirectory(root, remove);
    await Promise.all([cleanup(), cleanup()]);
    expect(remove).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
