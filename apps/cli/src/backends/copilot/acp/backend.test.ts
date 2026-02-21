import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('copilot/acp/backend', () => {
  it('builds stable AcpBackendOptions for Copilot ACP spawn', async () => {
    vi.stubEnv('HAPPIER_COPILOT_PATH', undefined);

    const mod = await import('./backend');

    const opts = mod.buildCopilotAcpBackendOptions({
      cwd: '/tmp',
      env: { DEBUG: '1', NODE_ENV: 'development', FOO: 'bar' },
      permissionMode: 'bypassPermissions',
      mcpServers: { test: { command: 'node', args: ['-e', 'console.log(1)'], env: { A: 'B' } } },
      permissionHandler: undefined,
    });

    expect(opts.agentName).toBe('copilot');
    expect(opts.cwd).toBe('/tmp');
    expect(opts.command).toBe('copilot');
    expect(opts.args).toEqual(['--acp', '--yolo']);
    expect(opts.env).toEqual({
      NODE_ENV: 'development',
      DEBUG: '1',
      FOO: 'bar',
    });
    expect(opts.transportHandler).toBeDefined();
    expect(opts.mcpServers).toEqual({
      test: { command: 'node', args: ['-e', 'console.log(1)'], env: { A: 'B' } },
    });
  });

  it('uses HAPPIER_COPILOT_PATH when it points to an executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-copilot-path-'));
    const fake = join(dir, 'copilot');
    try {
      await writeFile(fake, '#!/bin/sh\necho hi\n', 'utf8');
      await chmod(fake, 0o755);
      vi.stubEnv('HAPPIER_COPILOT_PATH', fake);

      const mod = await import('./backend');
      const opts = mod.buildCopilotAcpBackendOptions({ cwd: dir, env: {} });
      expect(opts.command).toBe(fake);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

