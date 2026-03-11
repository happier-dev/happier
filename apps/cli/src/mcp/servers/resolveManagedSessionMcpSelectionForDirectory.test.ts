import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import { resolveManagedSessionMcpSelectionForDirectory } from './resolveManagedSessionMcpSelectionForDirectory';

describe('resolveManagedSessionMcpSelectionForDirectory', () => {
  it('supports manual include resolution under symlinked workspaces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-selection-realpath-'));
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
            id: 'server-1',
            name: 'playwright',
            transport: 'stdio',
            stdio: { command: 'node', args: [] },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [
          {
            id: 'binding-1',
            serverId: 'server-1',
            enabled: false,
            target: { t: 'workspace', machineId: 'machine-1', workspaceRoot: linkRoot },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });

      const resolved = resolveManagedSessionMcpSelectionForDirectory({
        settings,
        machineId: 'machine-1',
        directory: realSub,
        selection: {
          v: 1,
          managedServersEnabled: true,
          forceIncludeServerIds: ['server-1'],
          forceExcludeServerIds: [],
        },
      });

      expect(resolved.selectedServersByName.playwright?.bindingId).toBe('binding-1');
      expect(resolved.itemsByName.playwright?.reasonCode).toBe('forced_included');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
