import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema, type McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { projectMcpServerMaterializationV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';

import { hasExplicitlyEmptyManagedMcpSelection, resolveSessionCapabilitiesForDirectory } from './resolveSessionCapabilitiesForDirectory';

function resolveMcpMaterializationForDirectory(input: { settings: McpServersSettingsV1; machineId: string; directory: string; machinePlatform?: 'win32' | 'posix' }) {
  return projectMcpServerMaterializationV1(resolveSessionCapabilitiesForDirectory(input), input.directory);
}

describe('resolveSessionCapabilitiesForDirectory configuration projection', () => {
  it('keeps explicitly empty managed selection independent of built-in tool delivery', () => {
    expect(hasExplicitlyEmptyManagedMcpSelection({ mcpSelectionV1: {
      managedServersEnabled: false, happierToolsEnabled: false,
    } })).toBe(true);
  });

  it.each([
    { workspaceRoot: 'C:\\work\\repo', directory: 'C:\\Work/Repo\\nested' },
    { workspaceRoot: '\\\\host\\share\\repo', directory: '\\\\HOST\\Share/repo\\nested' },
  ])('matches Windows workspace $workspaceRoot case-insensitively on a win32 machine and retains nullable configuration overrides', ({ workspaceRoot, directory }) => {
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'server', name: 'remote', transport: 'http', remote: { url: 'https://example.test/mcp',
        headers: { Authorization: { t: 'literal', v: 'remove' }, Keep: { t: 'literal', v: 'base' } } },
      env: { REMOVE: { t: 'literal', v: 'remove' } }, createdAt: 1, updatedAt: 1,
      configOverrides: [{ target: { t: 'workspace', machineId: 'machine', workspaceRoot }, envPatch: { REMOVE: null }, remote: { headersPatch: {
        Authorization: null, Keep: { t: 'literal', v: 'overridden' },
      } } }],
    }], bindings: [{ id: 'workspace', serverId: 'server', enabled: true,
      target: { t: 'workspace', machineId: 'machine', workspaceRoot },
      createdAt: 1, updatedAt: 1,
    }] });
    // The machine platform input selects win32 comparison on every host, so the
    // differently cased directory only matches through the Windows branch.
    const resolved = resolveMcpMaterializationForDirectory({ settings, machineId: 'machine', directory, machinePlatform: 'win32' });
    expect(resolved.serversByName.remote).toMatchObject({ enabled: true, bindingId: 'workspace', config: {
      transport: 'http', env: {}, remote: { headers: { Keep: { t: 'literal', v: 'overridden' } } },
    } });
    expect(resolved.serversByName.remote.config.remote?.headers).not.toHaveProperty('Authorization');
  });

  it('matches workspace bindings under symlinks via realpath normalization, including a forced include over an Off binding', async () => {
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

      const resolved = resolveMcpMaterializationForDirectory({ settings, machineId: 'm1', directory: realSub });
      expect(resolved.serversByName.alpha.bindingId).toBe('ws');
      expect(resolved.serversByName.alpha.enabled).toBe(true);

      const forced = resolveSessionCapabilitiesForDirectory({
        settings: { ...settings, bindings: settings.bindings.map(binding => ({ ...binding, enabled: false })) },
        machineId: 'm1',
        directory: realSub,
        selection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['s1'], forceExcludeServerIds: [] } },
      });
      expect(forced.selectedServersByName.alpha?.bindingId).toBe('ws');
      expect(forced.itemsByName.alpha?.reasonCode).toBe('forced_included');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
