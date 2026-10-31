import { describe, expect, it } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';

import { resolveRunnerMcpServers } from './resolveRunnerMcpServers';

describe('runner MCP preparation warnings', () => {
  it.each([false, true])('omits built-in tools without starting their bridge (has settings: %s)', async (hasSettings) => {
    const prepared = await resolveRunnerMcpServers({
      session: {
        sessionId: 'restricted-session',
        rpcHandlerManager: { registerHandler: () => undefined, invokeLocal: async () => undefined },
        sendClaudeSessionMessage: () => undefined,
        updateMetadata: () => undefined,
      },
      credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      accountSettings: hasSettings ? AccountSettingsSchema.parse({
        mcpServersSettingsV1: {
          v: 1, strictMode: false,
          servers: [{
            id: 'repo-tools', name: 'repo-tools', transport: 'stdio',
            stdio: { command: process.execPath, args: ['--version'] },
            env: {}, createdAt: 1, updatedAt: 1,
          }],
          bindings: [{
            id: 'repo-tools-binding', serverId: 'repo-tools', enabled: true,
            target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
          }],
        },
      }) : null,
      sessionMetadata: { mcpSelectionV1: { happierToolsEnabled: false } },
      machineId: 'test-machine',
      directory: process.cwd(),
      env: {},
    });
    try {
      expect(Object.keys(prepared.mcpServers)).toEqual(hasSettings ? ['repo-tools'] : []);
      expect(prepared.happierMcpServer.url).toBe('');
    } finally {
      prepared.happierMcpServer.stop();
    }
  });

  it('reports an omitted server to the session through the real preparation path', async () => {
    const events: unknown[] = [];
    const session = {
      sessionId: 'mcp-warning-session',
      rpcHandlerManager: {
        registerHandler: () => undefined,
        invokeLocal: async () => undefined,
      },
      sendClaudeSessionMessage: () => undefined,
      updateMetadata: () => undefined,
      sendSessionEvent: (event: unknown) => { events.push(event); },
    } satisfies HappyMcpSessionClient;
    const credentials: Credentials = {
      token: 'test-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    };
    const prepared = await resolveRunnerMcpServers({
      session,
      credentials,
      accountSettings: AccountSettingsSchema.parse({
        mcpServersSettingsV1: {
          v: 1,
          strictMode: false,
          servers: [{
            id: 'optional-docs', name: 'docs', transport: 'stdio',
            stdio: { command: 'npx', args: ['example-mcp'] },
            env: { TOKEN: { t: 'savedSecret', secretId: 'missing' } },
            createdAt: 1, updatedAt: 1,
          }],
          bindings: [{
            id: 'optional-docs-binding', serverId: 'optional-docs', enabled: true,
            target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
          }],
        },
      }),
      machineId: 'test-machine',
      directory: process.cwd(),
      env: {},
      tmpDir: null,
    });
    try {
      expect(prepared.mcpServers.docs).toBeUndefined();
      expect(events).toEqual([expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('docs'),
      })]);
    } finally {
      prepared.happierMcpServer.stop();
    }
  });
});
