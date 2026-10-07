import { afterEach, describe, expect, it, vi } from 'vitest';

// Process execution is the external boundary: static help must not launch
// either the default Agent or an uninstaller.
const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn(() => {
  throw new Error('Static uninstall help must not launch a process');
}) }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync,
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli uninstall command', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes happier uninstall to its static help without falling through to an Agent', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await dispatchCli({
      args: ['uninstall', '--help'],
      rawArgv: ['happier', 'uninstall', '--help'],
      terminalRuntime: null,
    });

    const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(text).toContain('happier uninstall');
    expect(text).toContain('--keep-service');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
