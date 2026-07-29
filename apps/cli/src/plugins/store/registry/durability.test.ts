import { describe, expect, it, vi } from 'vitest';

import { flushFileDurably } from './durability';

describe('flushFileDurably', () => {
  it('opens Windows files with write access before fsync', async () => {
    const sync = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const openFile = vi.fn(async () => ({ sync, close }));

    await flushFileDurably('C:\\state\\registry.json', {
      platform: 'win32',
      openFile,
    });

    expect(openFile).toHaveBeenCalledWith('C:\\state\\registry.json', 'r+');
    expect(sync).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
