import { describe, expect, it, vi } from 'vitest';

import type { McpCommandDeps } from './deps';
import { runMcpServeCommand } from './serve';
import { disableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';

describe('runMcpServeCommand', () => {
  it('bootstraps account settings before starting the stdio MCP server', async () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };

    const connect = vi.fn(async () => {});
    const deps: McpCommandDeps = {
      readCredentials: async () => credentials,
      bootstrapAccountSettingsContext: vi.fn(async () => ({}) as any),
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({ version: 1 }) as any),
      ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
      detectProviderMcpServers: vi.fn(async () => ({ ok: true, servers: [] }) as any),
      probeMcpStdioServerTools: vi.fn(async () => ({ ok: true, toolNames: [] }) as any),
      randomUUID: () => 'id',
      nowMs: () => 1,
      createExternalMcpServer: vi.fn(() => ({ mcp: { connect }, toolNames: [] }) as any),
      connectMcpStdio: vi.fn(async (_server) => {}),
    };

    try {
      await runMcpServeCommand(['serve', '--session', 'sess-1'], deps);

      expect(deps.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
        credentials,
        mode: 'blocking',
        refresh: 'force',
      }));
      expect(deps.ensureMachineIdForCredentials).toHaveBeenCalledWith(credentials);
      expect(deps.createExternalMcpServer).toHaveBeenCalledWith({ credentials, defaultSessionId: 'sess-1' });
      expect(deps.connectMcpStdio).toHaveBeenCalledWith(expect.objectContaining({ connect }));
    } finally {
      disableMcpStdioConsolePatch();
    }
  });

  it('patches console output to avoid stdout corruption in stdio MCP mode', async () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };

    const deps: McpCommandDeps = {
      readCredentials: async () => credentials,
      bootstrapAccountSettingsContext: vi.fn(async () => ({}) as any),
      updateAccountSettingsV2WithRetry: vi.fn(async () => ({ version: 1 }) as any),
      ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
      detectProviderMcpServers: vi.fn(async () => ({ ok: true, servers: [] }) as any),
      probeMcpStdioServerTools: vi.fn(async () => ({ ok: true, toolNames: [] }) as any),
      randomUUID: () => 'id',
      nowMs: () => 1,
      createExternalMcpServer: vi.fn(() => ({ mcp: { connect: vi.fn(async () => {}) }, toolNames: [] }) as any),
      connectMcpStdio: vi.fn(async (_server) => {}),
    };

    const original = console.log;
    try {
      await runMcpServeCommand(['serve'], deps);
      expect(console.log).not.toBe(original);
    } finally {
      disableMcpStdioConsolePatch();
    }
    expect(console.log).toBe(original);
  });
});
