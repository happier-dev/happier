import { describe, it, expect } from 'vitest';

import { buildAcpSpawnSpec } from '../acpSpawn';

describe('buildAcpSpawnSpec', () => {
  it('preserves args as separate entries (no string join)', () => {
    const spec = buildAcpSpawnSpec({
      command: 'agent',
      args: ['--path', 'C:\\My Documents\\file.txt', '--flag'],
    });

    expect(spec.command).toBe('agent');
    expect(spec.args).toEqual(['--path', 'C:\\My Documents\\file.txt', '--flag']);
  });

  it('does not detach ACP agents by default (posix)', () => {
    const spec = buildAcpSpawnSpec({
      command: 'agent',
      args: [],
    });

    if (process.platform === 'win32') {
      expect(spec.options.detached).not.toBe(true);
      return;
    }

    // Keep ACP CLIs attached so outer test harnesses can terminate the full tree by killing the CLI.
    // We handle child-process cleanup inside the CLI with a process-tree kill strategy.
    expect(spec.options.detached).not.toBe(true);
  });
});
