import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';

import { resolveEffectiveMcpServersForDirectory } from './resolveEffectiveMcpServersForDirectory';

describe('resolveEffectiveMcpServersForDirectory', () => {
  it.each([
    { workspaceRoot: 'C:\\work\\repo', directory: 'C:\\work/repo\\nested' },
    { workspaceRoot: '\\\\host\\share\\repo', directory: '\\\\host\\share/repo\\nested' },
  ])('matches Windows workspace $workspaceRoot and retains nullable binding overrides', ({ workspaceRoot, directory }) => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'server', name: 'remote', transport: 'http', remote: { url: 'https://example.test/mcp',
        headers: { Authorization: { t: 'literal', v: 'remove' }, Keep: { t: 'literal', v: 'base' } } },
      env: { REMOVE: { t: 'literal', v: 'remove' } }, createdAt: 1, updatedAt: 1,
    }], bindings: [{ id: 'workspace', serverId: 'server', enabled: true,
      target: { t: 'workspace', machineId: 'machine', workspaceRoot },
      overrides: { envPatch: { REMOVE: null }, remote: { headersPatch: {
        Authorization: null, Keep: { t: 'literal', v: 'overridden' },
      } } }, createdAt: 1, updatedAt: 1,
    }] });
    const resolved = resolveEffectiveMcpServersForDirectory({ settings, machineId: 'machine', directory });
    expect(resolved.serversByName.remote).toMatchObject({ enabled: true, bindingId: 'workspace', config: {
      transport: 'http', env: {}, remote: { headers: { Keep: { t: 'literal', v: 'overridden' } } },
    } });
    expect(resolved.serversByName.remote.config.remote?.headers).not.toHaveProperty('Authorization');
  });

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
