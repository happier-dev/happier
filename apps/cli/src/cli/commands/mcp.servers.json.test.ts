import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol';

import { handleMcpCommand } from './mcp';

function createCredentialsStub(): Credentials {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

describe('happier mcp servers --json', () => {
  it('prints a mcp_servers_list JSON envelope', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const bootstrapCalls: unknown[] = [];
      const mcpSettings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 'srv-1',
            name: 'example',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
            env: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        bindings: [
          {
            id: 'bind-1',
            serverId: 'srv-1',
            enabled: true,
            target: { t: 'allMachines' },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });

      await handleMcpCommand(['servers', 'list', '--json'], {
        readCredentials: async () => createCredentialsStub(),
        bootstrapAccountSettingsContext: async (args: unknown) => {
          bootstrapCalls.push(args);
          return {
            source: 'network',
            settings: { mcpServersSettingsV1: mcpSettings } as any,
            settingsVersion: 10,
            loadedAtMs: 1,
            whenRefreshed: null,
          };
        },
      } as any);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('mcp_servers_list');
      expect(parsed.data?.strictMode).toBe(false);
      expect(Array.isArray(parsed.data?.servers)).toBe(true);
      expect(parsed.data.servers).toEqual([
        expect.objectContaining({ id: 'srv-1', name: 'example', transport: 'stdio', bindingCount: 1 }),
      ]);
      expect(bootstrapCalls).toEqual([
        expect.objectContaining({ mode: 'blocking', refresh: 'force' }),
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a mcp_servers_add JSON envelope and adds a stdio server', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      let storedSettings: Record<string, unknown> = {
        mcpServersSettingsV1: McpServersSettingsV1Schema.parse({
          v: 1,
          strictMode: false,
          servers: [],
          bindings: [],
        }),
      };

      await handleMcpCommand([
        'servers',
        'add',
        '--name',
        'example',
        '--transport',
        'stdio',
        '--command',
        'node',
        '--arg',
        'server.js',
        '--json',
      ], {
        readCredentials: async () => createCredentialsStub(),
        randomUUID: () => 'srv-1',
        nowMs: () => 123,
        updateAccountSettingsV2WithRetry: async ({ mutate }: any) => {
          storedSettings = mutate(storedSettings);
          return { version: 11 };
        },
      } as any);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('mcp_servers_add');
      expect(parsed.data?.created?.id).toBe('srv-1');
      expect(parsed.data?.created?.name).toBe('example');

      const next = McpServersSettingsV1Schema.parse((storedSettings as any).mcpServersSettingsV1);
      expect(next.servers).toHaveLength(1);
      expect(next.servers[0]).toMatchObject({
        id: 'srv-1',
        name: 'example',
        transport: 'stdio',
        stdio: { command: 'node', args: ['server.js'] },
      });
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a mcp_servers_bind JSON envelope and creates a binding', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      let storedSettings: Record<string, unknown> = {
        mcpServersSettingsV1: McpServersSettingsV1Schema.parse({
          v: 1,
          strictMode: false,
          servers: [
            {
              id: 'srv-1',
              name: 'example',
              transport: 'stdio',
              stdio: { command: 'node', args: ['server.js'] },
              env: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          bindings: [],
        }),
      };

      const ids = ['bind-1'];

      await handleMcpCommand([
        'servers',
        'bind',
        '--server',
        'example',
        '--all-machines',
        '--json',
      ], {
        readCredentials: async () => createCredentialsStub(),
        randomUUID: () => ids.shift() ?? 'bind-fallback',
        nowMs: () => 456,
        updateAccountSettingsV2WithRetry: async ({ mutate }: any) => {
          storedSettings = mutate(storedSettings);
          return { version: 12 };
        },
      } as any);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('mcp_servers_bind');
      expect(parsed.data?.createdBindingId).toBe('bind-1');

      const next = McpServersSettingsV1Schema.parse((storedSettings as any).mcpServersSettingsV1);
      expect(next.bindings).toHaveLength(1);
      expect(next.bindings[0]).toMatchObject({
        id: 'bind-1',
        serverId: 'srv-1',
        enabled: true,
        target: { t: 'allMachines' },
      });
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a mcp_servers_unbind JSON envelope and removes a binding', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      let storedSettings: Record<string, unknown> = {
        mcpServersSettingsV1: McpServersSettingsV1Schema.parse({
          v: 1,
          strictMode: false,
          servers: [
            {
              id: 'srv-1',
              name: 'example',
              transport: 'stdio',
              stdio: { command: 'node', args: ['server.js'] },
              env: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          bindings: [
            {
              id: 'bind-1',
              serverId: 'srv-1',
              enabled: true,
              target: { t: 'allMachines' },
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      };

      await handleMcpCommand([
        'servers',
        'unbind',
        '--binding-id',
        'bind-1',
        '--json',
      ], {
        readCredentials: async () => createCredentialsStub(),
        updateAccountSettingsV2WithRetry: async ({ mutate }: any) => {
          storedSettings = mutate(storedSettings);
          return { version: 13 };
        },
      } as any);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('mcp_servers_unbind');
      expect(parsed.data?.removedBindingId).toBe('bind-1');

      const next = McpServersSettingsV1Schema.parse((storedSettings as any).mcpServersSettingsV1);
      expect(next.bindings).toHaveLength(0);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a mcp_servers_detect JSON envelope', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleMcpCommand([
        'servers',
        'detect',
        '--provider',
        'claude',
        '--json',
      ], {
        detectProviderMcpServers: async () => ({
          servers: [
            {
              provider: 'claude',
              name: 'claude-detected',
              transport: 'stdio',
              stdio: { command: 'node', args: ['server.js'] },
              envKeys: ['API_KEY'],
              enabled: true,
              source: { kind: 'user', path: '/tmp/claude.json' },
            },
          ],
          warnings: [],
        }),
      } as any);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('mcp_servers_detect');
      expect(parsed.data?.servers).toEqual([
        expect.objectContaining({ provider: 'claude', name: 'claude-detected', transport: 'stdio' }),
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a mcp_servers_test JSON envelope', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const bootstrapCalls: unknown[] = [];
      const mcpSettings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: true,
        servers: [
          {
            id: 'srv-1',
            name: 'example',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
            env: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        bindings: [
          {
            id: 'bind-1',
            serverId: 'srv-1',
            enabled: true,
            target: { t: 'allMachines' },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });

      await handleMcpCommand([
        'servers',
        'test',
        '--server',
        'example',
        '--dir',
        '/tmp',
        '--json',
      ], {
        readCredentials: async () => createCredentialsStub(),
        ensureMachineIdForCredentials: async () => ({ machineId: 'machine-1' }),
        bootstrapAccountSettingsContext: async (args: unknown) => {
          bootstrapCalls.push(args);
          return {
            source: 'network',
            settings: { mcpServersSettingsV1: mcpSettings } as any,
            settingsVersion: 10,
            loadedAtMs: 1,
            whenRefreshed: null,
          };
        },
        probeMcpStdioServerTools: async () => [{ name: 'tool-a' }, { name: 'tool-b' }],
      } as any);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('mcp_servers_test');
      expect(parsed.data?.toolCount).toBe(2);
      expect(parsed.data?.toolNamesSample).toEqual(['tool-a', 'tool-b']);
      expect(typeof parsed.data?.durationMs).toBe('number');
      expect(bootstrapCalls).toEqual([
        expect.objectContaining({ mode: 'blocking', refresh: 'force' }),
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});
