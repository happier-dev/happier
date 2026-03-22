import { afterEach, describe, expect, it } from 'vitest';

import { buildAcpSpawnSpec } from '../acpSpawn';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('buildAcpSpawnSpec', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const envScope = createEnvKeyScope(['PATH', 'PATHEXT']);

  afterEach(async () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    envScope.restore();
  });

  it('preserves args as separate entries (no string join)', () => {
    const spec = buildAcpSpawnSpec({
      command: 'agent',
      args: ['--path', 'C:\\My Documents\\file.txt', '--flag'],
    });

    expect(spec.command).toBe('agent');
    expect(spec.args).toEqual(['--path', 'C:\\My Documents\\file.txt', '--flag']);
  });

  it('wraps command-only .cmd shims with cmd.exe on Windows', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }

    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    await withTempDir('happier-acpSpawn-', async (binDir) => {
      await writeFile(join(binDir, 'npx.CMD'), '@echo off\r\necho ok\r\n', 'utf8');
      envScope.patch({ PATH: binDir, PATHEXT: '.CMD' });

      const spec = buildAcpSpawnSpec({
        command: 'npx',
        args: ['-y', '@zed-industries/codex-acp'],
        env: { ...process.env },
      });

      expect(spec.command.toLowerCase()).toContain('cmd');
      expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(spec.args[3]).toContain('npx.CMD');
      expect(spec.args[3]).toContain('@zed-industries/codex-acp');
      expect(spec.options.windowsVerbatimArguments).toBe(true);
      expect(spec.options.windowsHide).toBe(true);
    });
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
