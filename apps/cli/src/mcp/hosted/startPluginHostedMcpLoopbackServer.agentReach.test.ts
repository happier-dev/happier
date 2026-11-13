import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  McpServersSettingsV1Schema,
  projectMcpServerMaterializationV1,
  resolveSessionCapabilitiesV1,
  type McpServersSettingsV1,
} from '@happier-dev/protocol';

import { buildOutboundSessionMessagePayload } from '@/api/session/client/transport/outboundSessionMessagePayload';
import { applyAttachedPluginMcpTransport } from '@/mcp/runtime/applyAttachedPluginMcpTransport';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { startPluginHostedMcpLoopbackServer } from './startPluginHostedMcpLoopbackServer';

function resolveMaterialization(settings: McpServersSettingsV1) {
  return projectMcpServerMaterializationV1(
    resolveSessionCapabilitiesV1({
      context: {
        machineId: 'm1',
        directory: '/repo',
        machinePlatform: null,
        projectKey: null,
        agentId: null,
      },
      mcp: settings,
      skills: null,
      selection: {},
      agentAcceptsUserMcp: true,
    }),
    '/repo',
  );
}

// A plugin-hosted MCP server listens on 127.0.0.1 (no kernel peer proof), so its bearer is the
// admission. It must reach the Agent's MCP client only through the runner-written private bridge
// config, never the Agent-visible Session context or env, and a transcript echoing it is redacted.
describe('plugin-hosted loopback MCP bearer and the Agent', () => {
  it('stays in the private bridge config and is redacted from transcripts while live', async () => {
    const server = await startPluginHostedMcpLoopbackServer({
      pluginId: 'acme',
      spec: {
        id: 'acme.reach',
        name: 'acme-reach',
        transport: {
          kind: 'hosted',
          exposure: { kind: 'loopbackHttp', requested: true },
        },
        hosted: {
          tools: [
            {
              name: 'ext.acme.read',
              inputSchema: { type: 'object' },
              handler: async () => ({ content: [] }),
            },
          ],
        },
      },
    });
    const authorization = server.endpoint.headers.authorization;
    const bearer = authorization.slice('Bearer '.length);
    const dir = await mkdtemp(join(tmpdir(), 'happier-plugin-hosted-reach-'));
    try {
      const row = {
        config: McpServersSettingsV1Schema.parse({
          v: 1,
          strictMode: true,
          servers: [
            {
              id: 'acme-reach',
              name: 'acme-reach',
              transport: 'http',
              remote: { url: 'http://127.0.0.1', headers: {} },
              env: {},
              createdAt: 0,
              updatedAt: 0,
            },
          ],
          bindings: [],
        }).servers[0]!,
      };
      const attached = applyAttachedPluginMcpTransport(row, {
        kind: 'http',
        url: server.endpoint.url,
        headers: server.endpoint.headers,
      });
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: true,
        servers: [attached.config],
        bindings: [
          {
            id: 'b1',
            serverId: 'acme-reach',
            enabled: true,
            target: { t: 'allMachines' },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });
      const out = await materializeMcpServerConfigRecord({
        resolved: resolveMaterialization(settings),
        processEnv: {},
        tmpDir: dir,
        deps: {
          resolveRemoteBridgeCommand: () => ({
            command: 'happier-mcp-bridge',
            args: ['remote'],
          }),
        },
      });
      const config = out.mcpServers['acme-reach'];
      if (!config) throw new Error('missing materialized plugin MCP config');
      // The Agent's MCP client config names only the private bridge file; the bearer lives inside it.
      expect(JSON.stringify(config).includes(bearer)).toBe(false);
      expect(Object.keys(config.env ?? {})).toEqual([
        'HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE',
      ]);
      expect(
        (
          await readFile(
            String(config.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE),
            'utf8',
          )
        ).includes(bearer),
      ).toBe(true);
      out.cleanup();

      const payload = buildOutboundSessionMessagePayload(
        { mode: 'plain', ctx: null },
        {
          role: 'agent',
          content: {
            type: 'tool-call',
            input: { command: `curl -H "Authorization: ${authorization}"` },
          },
        },
      );
      expect(JSON.stringify(payload).includes(bearer)).toBe(false);
    } finally {
      await server.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
