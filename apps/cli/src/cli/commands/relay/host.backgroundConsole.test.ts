import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { runRelayHostSubcommand } from './host';

// SSH is the external process boundary; keep relay dispatch and its engine real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'SSH fixture unavailable' })) };
});

describe('relay host background SSH', () => {
  it('hides captured remote status probes', async () => {
    await expect(runRelayHostSubcommand(['status', '--ssh', 'user@example.invalid', '--json'])).rejects.toThrow();
    expect(spawnSync).toHaveBeenCalledWith('ssh', expect.any(Array), expect.objectContaining({
      windowsHide: true, encoding: 'utf8',
    }));
  });
});
