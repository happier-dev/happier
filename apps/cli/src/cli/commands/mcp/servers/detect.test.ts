import { describe, expect, it, vi } from 'vitest';

import type { McpCommandDeps } from '../deps';
import { cmdMcpServersDetect } from './detect';

function createDeps(overrides?: Partial<McpCommandDeps>): McpCommandDeps {
  return {
    readStoredCredentials: vi.fn(async () => null),
    bootstrapAccountSettingsContext: vi.fn(async () => ({}) as any),
    updateAccountSettingsV2WithRetry: vi.fn(async () => ({}) as any),
    ensureMachineIdForCredentials: vi.fn(async () => ({ machineId: 'machine-1' })),
    detectProviderMcpServers: vi.fn(async () => ({ servers: [], warnings: [] })),
    probeMcpStdioServerTools: vi.fn(async () => []),
    randomUUID: vi.fn(() => 'uuid'),
    nowMs: vi.fn(() => 0),
    createExternalMcpServer: vi.fn(() => ({ mcp: { connect: vi.fn(async () => {}) }, toolNames: [] }) as any),
    connectMcpStdio: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('cmdMcpServersDetect', () => {
  it('forwards command env to provider MCP detection', async () => {
    const env = {
      HAPPIER_MCP_DISCOVERY_PROVIDER_TIMEOUT_MS: '42',
    } as NodeJS.ProcessEnv;
    const deps = createDeps({ env });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await cmdMcpServersDetect(['--provider', 'codex', '--dir', '/repo'], deps, { json: true });
    } finally {
      consoleLog.mockRestore();
    }

    expect(deps.detectProviderMcpServers).toHaveBeenCalledWith({
      directory: '/repo',
      providers: ['codex'],
      env,
    });
  });
});
