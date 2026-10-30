import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema, type McpServersSettingsV1 } from '../mcp/servers/settingsV1.js';
import { projectMcpServerMaterializationV1, resolveSessionCapabilitiesV1 } from './resolveSessionCapabilitiesV1.js';

function resolveMcpMaterialization(settings: McpServersSettingsV1, context: { machineId: string; directory: string }) {
  return projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({ context: { ...context, machinePlatform: null, projectKey: null, agentId: null },
    mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true }), context.directory);
}

describe('resolveSessionCapabilitiesV1 predecessor place precedence', () => {
  it('matches platform root workspaces without admitting a sibling volume or prefix', () => {
    for (const [workspaceRoot, child, sibling] of [
      ['C:\\', 'C:\\workspace\\child', 'D:\\workspace\\child'],
      ['/', '/workspace/child', 'C:\\workspace\\child'],
      ['\\\\server\\share', '\\\\server\\share\\workspace', '\\\\server\\share-other\\workspace'],
      ['C:\\work', 'C:\\work\\child', 'C:\\workspace\\child'],
    ] as const) {
      const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: false,
        servers: [{ id: 's1', name: 'alpha', transport: 'stdio', stdio: { command: 'server', args: [] },
          env: {}, createdAt: 0, updatedAt: 0 }],
        bindings: [{ id: 'workspace', serverId: 's1', enabled: true,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot }, createdAt: 0, updatedAt: 0 }],
      });
      expect(resolveMcpMaterialization(settings, { machineId: 'm1', directory: child }).serversByName.alpha.enabled).toBe(true);
      expect(resolveMcpMaterialization(settings, { machineId: 'm1', directory: sibling }).serversByName.alpha.enabled).toBe(false);
    }
  });

  it('applies precedence: workspace > machine > allMachines', () => {
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
        { id: 'all', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 3 },
        { id: 'machine', serverId: 's1', enabled: true, target: { t: 'machine', machineId: 'm1' }, createdAt: 0, updatedAt: 2 },
        {
          id: 'ws',
          serverId: 's1',
          enabled: true,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot: '/repo' },
          createdAt: 0,
          updatedAt: 1,
        },
      ],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo/sub' });
    expect(resolved.serversByName.alpha.bindingId).toBe('ws');
    expect(resolved.serversByName.alpha.enabled).toBe(true);
    expect(resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/outside' }).serversByName.alpha.bindingId).toBe('machine');
    expect(resolveMcpMaterialization(settings, { machineId: 'm2', directory: '/repo/sub' }).serversByName.alpha.bindingId).toBe('all');
  });

  it('chooses the longest matching workspaceRoot when multiple workspaces match', () => {
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
          id: 'ws1',
          serverId: 's1',
          enabled: true,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot: '/repo' },
          createdAt: 0,
          updatedAt: 2,
        },
        {
          id: 'ws2',
          serverId: 's1',
          enabled: true,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot: '/repo/sub' },
          createdAt: 0,
          updatedAt: 1,
        },
      ],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo/sub/child' });
    expect(resolved.serversByName.alpha.bindingId).toBe('ws2');
  });

  it('allows workspace deny bindings to override allMachines allow bindings', () => {
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
        { id: 'all', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 1 },
        {
          id: 'ws-deny',
          serverId: 's1',
          enabled: false,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot: '/repo' },
          createdAt: 0,
          updatedAt: 2,
        },
      ],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    expect(resolved.serversByName.alpha.bindingId).toBe('ws-deny');
    expect(resolved.serversByName.alpha.enabled).toBe(false);
  });

  it('returns enabled=false when a server has no matching bindings', () => {
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
      bindings: [],
    });

    const resolved = resolveMcpMaterialization(settings, { machineId: 'm1', directory: '/repo' });
    expect(resolved.serversByName.alpha.enabled).toBe(false);
    expect(resolved.serversByName.alpha.bindingId).toBeNull();
  });
});
