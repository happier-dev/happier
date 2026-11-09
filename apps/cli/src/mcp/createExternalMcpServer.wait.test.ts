import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { configuration, reloadConfiguration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createExternalMcpServer } from './createExternalMcpServer';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
// Daemon control RPC is the substituted boundary; SDK and in-memory transport are real.
vi.mock('@/daemon/controlClient', () => ({ requestDaemonPluginActionExecution: request }));

const credentials = {
  token: `header.${Buffer.from(JSON.stringify({ sub: 'wait-owner' })).toString('base64url')}.signature`,
  encryption: null, credentialProvenance: 'stored_session' as const,
};
let homeDir: string;
let app: ReturnType<typeof fastify>;
beforeEach(async () => {
  homeDir = await createTempDir('happier-mcp-wait-');
  app = fastify();
  registerAccountHomeHttp(app, { accountId: 'wait-owner', serverId: 'wait-home' });
  const endpoint = await app.listen({ port: 0, host: '127.0.0.1' });
  vi.stubEnv('HAPPIER_HOME_DIR', homeDir);
  vi.stubEnv('HAPPIER_SERVER_URL', endpoint);
  vi.stubEnv('HAPPIER_WEBAPP_URL', endpoint);
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {
    wait: { toolExposureModes: { mcp: 'direct' } },
  } }));
  reloadConfiguration();
  // The command admits these credentials before constructing the MCP host.
  await writeStoredCredentialsForServerId(configuration.activeServerId, credentials);
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  reloadConfiguration();
  if (homeDir) await removeTempDir(homeDir);
});

it('external MCP wait enters the admitted plugin Action through its captured Home', async () => {
  request.mockImplementation(async (value: { actionId: string; input: unknown }) => {
    if (value.actionId === 'action.spec.get') {
      // Typed Machine placement is read before any effect reaches the daemon.
      return { matched: true, result: { ok: true, result: PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse({ actionSpec: {
        id: (value.input as { id: string }).id, title: 'Observe checks', description: null, safety: 'safe', executionPlacement: 'machine',
        placements: [], slash: null, bindings: null, examples: null, surfaces: { mcp: true }, inputHints: null, inputSchema: { type: 'object' },
      } }) } };
    }
    expect(value).toMatchObject({ actionId: 'action.invoke', surface: 'mcp', input: {
      action: { pluginId: 'acme.checks', localId: 'observe/checks' },
      input: { sourceId: 'checkpoint', condition: 'checks_passed' },
    } });
    return { matched: true, result: { ok: true, result: { disposition: 'matched', snapshot: { passed: true } } } };
  });
  const { mcp, toolNames } = createExternalMcpServer({ credentials });
  const client = new Client({ name: 'external-watch-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
    expect(toolNames).toContain('watch');
    const response = CallToolResultSchema.parse(await client.callTool({ name: 'wait', arguments: {
      target: { kind: 'plugin_source', serverId: configuration.activeServerId, pluginId: 'acme.checks', sourceId: 'checkpoint' },
      condition: { kind: 'plugin', actionLocalId: 'observe/checks', condition: 'checks_passed' },
    } }));
    const text = response.content.find((entry) => entry.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Missing text result');
    expect(JSON.parse(text.text)).toMatchObject({ disposition: 'matched', snapshot: { passed: true } });
  } finally { await client.close(); await mcp.close(); }
});
