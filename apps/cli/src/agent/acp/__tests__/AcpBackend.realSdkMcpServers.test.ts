import { describe, expect, it } from 'vitest';

import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { McpServersSettingsV1Schema, resolveEffectiveServersV1 } from '@happier-dev/protocol';

import { AcpBackend } from '../AcpBackend';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { resolveSessionMcpPreview } from '@/mcp/preview/resolveSessionMcpPreview';

const ACP_STUB_PROVIDER_PATH = resolve(
  __dirname,
  '../../../../../../packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs',
);

describe('AcpBackend with real ACP SDK stub provider', () => {
  it.each([
    { capabilities: { http: true }, direct: 'http' },
    { capabilities: { sse: true }, direct: 'sse' },
    { capabilities: undefined, direct: undefined },
  ])('negotiates managed remote MCP on start and load with $capabilities', async ({ capabilities, direct }) => {
    await withTempDir('happier-acp-managed-mcp-', async (cwd) => {
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        servers: [
          { id: 'http', name: 'http', transport: 'http', remote: { url: 'https://example.test/old', headers: {} } },
          { id: 'sse', name: 'sse', transport: 'sse', remote: { url: 'https://example.test/sse', headers: {} } },
          { id: 'private', name: 'private', transport: 'http', remote: {
            url: 'https://example.test/private', headers: { Authorization: { t: 'literal', v: 'Bearer test-secret' } },
          } },
        ].map((server) => ({ ...server, env: {}, createdAt: 0, updatedAt: 0 })),
        bindings: ['http', 'sse', 'private'].map((serverId) => ({
          id: serverId, serverId, enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0,
          ...(serverId === 'http' ? { overrides: { remote: { url: 'http://127.0.0.1:4312/mcp' } } } : {}),
        })),
      });
      const materialized = await materializeMcpServerConfigRecord({
        resolved: resolveEffectiveServersV1(settings, { machineId: 'machine', directory: cwd }),
        settingsSecretsKey: null,
        savedSecretsById: new Map(),
        tmpDir: cwd,
      });
      const trace = resolve(cwd, 'mcp-requests.jsonl');
      const createBackend = () => new AcpBackend({
        agentName: 'test',
        cwd,
        command: process.execPath,
        args: [ACP_STUB_PROVIDER_PATH],
        env: {
          HAPPIER_E2E_ACP_STUB_SESSION_MCP_TRACE: trace,
          ...(capabilities ? { HAPPIER_E2E_ACP_STUB_MCP_CAPABILITIES: JSON.stringify(capabilities) } : {}),
        },
        mcpServers: materialized.mcpServers,
        transportHandler: createAcpTestTransportHandler(),
      });
      const backend = createBackend();
      const resumedBackend = createBackend();

      try {
        const { sessionId } = await backend.startSession();
        await resumedBackend.loadSession(sessionId);
        const wire = await readFile(trace, 'utf8');
        expect(wire).not.toContain('test-secret');
        const mcpServers = ['http', 'sse', 'private'].map((name) => name === direct
          ? { name, type: name, url: name === 'http' ? 'http://127.0.0.1:4312/mcp' : 'https://example.test/sse', headers: [] }
          : { name, command: expect.any(String), args: expect.any(Array), env: expect.arrayContaining([
            { name: 'HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE', value: expect.any(String) },
          ]) });
        expect(wire.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
          { method: 'session/new', mcpServers },
          { method: 'session/load', mcpServers },
        ]);
        const preview = resolveSessionMcpPreview({ settings, directory: cwd, machineId: 'machine', agentId: 'grok', detectedServers: [] });
        expect(preview.managed).toMatchObject([
          { name: 'http', acpDelivery: 'direct_if_supported' },
          { name: 'private', acpDelivery: 'bridge' },
          { name: 'sse', acpDelivery: 'direct_if_supported' },
        ]);
      } finally {
        await Promise.all([backend.dispose(), resumedBackend.dispose()]);
        materialized.cleanup();
      }
    });
  }, 15_000);

  it('normalizes configured MCP servers to ACP stdio server records', () => {
    const backend = new AcpBackend({
      agentName: 'test',
      cwd: process.cwd(),
      command: process.execPath,
      args: [ACP_STUB_PROVIDER_PATH],
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: { HAPPIER_MCP_TEST: '1' },
        },
      },
    });

    expect((backend as any).buildAcpMcpServersForSessionRequest()).toEqual([
      {
        name: 'happier',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: [{ name: 'HAPPIER_MCP_TEST', value: '1' }],
      },
    ]);
  });

  it('starts a session when MCP servers are included in the ACP session/new request', async () => {
    await withTempDir('happier-acp-real-sdk-mcp-', async (cwd) => {
      const backend = new AcpBackend({
        agentName: 'test',
        cwd,
        command: process.execPath,
        args: [ACP_STUB_PROVIDER_PATH],
        mcpServers: {
          happier: {
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: { HAPPIER_MCP_TEST: '1' },
          },
        },
        transportHandler: createAcpTestTransportHandler({ initTimeoutMs: 1_000 }),
      });

      try {
        await expect(backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 15_000);
});
