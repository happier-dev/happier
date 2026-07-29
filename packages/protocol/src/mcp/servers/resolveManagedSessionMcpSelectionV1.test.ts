import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from './settingsV1.js';
import { resolveManagedSessionMcpSelectionV1 } from './resolveManagedSessionMcpSelectionV1.js';

describe('resolveManagedSessionMcpSelectionV1', () => {
  it('keeps applicable enabled servers selected by default', () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'server-active',
          name: 'playwright',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'binding-active',
          serverId: 'server-active',
          enabled: true,
          target: { t: 'machine', machineId: 'machine-1' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const resolved = resolveManagedSessionMcpSelectionV1(settings, {
      machineId: 'machine-1',
      directory: '/repo',
    });

    expect(resolved.selectedServersByName.playwright?.bindingId).toBe('binding-active');
    expect(resolved.itemsByName.playwright).toMatchObject({
      selected: true,
      selectable: true,
      availability: 'active',
      reasonCode: 'active_by_default',
    });
  });

  it('allows force-excluding an active server for a session', () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'server-active',
          name: 'playwright',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'binding-active',
          serverId: 'server-active',
          enabled: true,
          target: { t: 'machine', machineId: 'machine-1' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const resolved = resolveManagedSessionMcpSelectionV1(settings, {
      machineId: 'machine-1',
      directory: '/repo',
      selection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: [],
        forceExcludeServerIds: ['server-active'],
      },
    });

    expect(resolved.selectedServersByName.playwright).toBeUndefined();
    expect(resolved.itemsByName.playwright).toMatchObject({
      selected: false,
      selectable: true,
      availability: 'available',
      reasonCode: 'forced_excluded',
    });
  });

  it('allows force-including a portable disabled server', () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'server-portable',
          name: 'context7',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'binding-all-disabled',
          serverId: 'server-portable',
          enabled: false,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const resolved = resolveManagedSessionMcpSelectionV1(settings, {
      machineId: 'machine-1',
      directory: '/repo',
      selection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['server-portable'],
        forceExcludeServerIds: [],
      },
    });

    expect(resolved.selectedServersByName.context7?.bindingId).toBe('binding-all-disabled');
    expect(resolved.itemsByName.context7).toMatchObject({
      selected: true,
      selectable: true,
      availability: 'active',
      reasonCode: 'forced_included',
      portability: 'portable',
    });
  });

  it('marks out-of-scope machine-specific servers as unavailable for manual include', () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'server-local',
          name: 'github',
          transport: 'stdio',
          stdio: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'binding-other-machine',
          serverId: 'server-local',
          enabled: true,
          target: { t: 'machine', machineId: 'machine-2' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const resolved = resolveManagedSessionMcpSelectionV1(settings, {
      machineId: 'machine-1',
      directory: '/repo',
      selection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['server-local'],
        forceExcludeServerIds: [],
      },
    });

    expect(resolved.selectedServersByName.github).toBeUndefined();
    expect(resolved.itemsByName.github).toMatchObject({
      selected: false,
      selectable: false,
      availability: 'unavailable',
      reasonCode: 'not_portable',
      portability: 'machine_scoped',
    });
  });

});
