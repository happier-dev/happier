import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from './settingsV1.js';
import { resolveEffectiveServersV1 } from './resolveEffectiveServersV1.js';

describe('resolveEffectiveServersV1', () => {
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
        { id: 'all', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 1 },
        { id: 'machine', serverId: 's1', enabled: true, target: { t: 'machine', machineId: 'm1' }, createdAt: 0, updatedAt: 2 },
        {
          id: 'ws',
          serverId: 's1',
          enabled: true,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot: '/repo' },
          createdAt: 0,
          updatedAt: 3,
        },
      ],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo/sub' });
    expect(resolved.serversByName.alpha.bindingId).toBe('ws');
    expect(resolved.serversByName.alpha.enabled).toBe(true);
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
          updatedAt: 1,
        },
        {
          id: 'ws2',
          serverId: 's1',
          enabled: true,
          target: { t: 'workspace', machineId: 'm1', workspaceRoot: '/repo/sub' },
          createdAt: 0,
          updatedAt: 2,
        },
      ],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo/sub/child' });
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

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });
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

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });
    expect(resolved.serversByName.alpha.enabled).toBe(false);
    expect(resolved.serversByName.alpha.bindingId).toBeNull();
  });
});

