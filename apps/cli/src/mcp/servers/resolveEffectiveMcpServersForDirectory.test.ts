import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import { resolveEffectiveMcpServersForDirectory } from './resolveEffectiveMcpServersForDirectory';

describe('resolveEffectiveMcpServersForDirectory', () => {
  it('matches workspace bindings under symlinks via realpath normalization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-realpath-'));
    try {
      const realRoot = join(dir, 'real');
      const realSub = join(realRoot, 'sub');
      await mkdir(realSub, { recursive: true });

      const linkRoot = join(dir, 'link');
      await symlink(realRoot, linkRoot);

      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'node', args: [] },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [
          {
            id: 'ws',
            serverId: 's1',
            enabled: true,
            target: { t: 'workspace', machineId: 'm1', workspaceRoot: linkRoot },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });

      const resolved = resolveEffectiveMcpServersForDirectory({ settings, machineId: 'm1', directory: realSub });
      expect(resolved.serversByName.alpha.bindingId).toBe('ws');
      expect(resolved.serversByName.alpha.enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

