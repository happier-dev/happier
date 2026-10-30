import { afterEach, describe, expect, it, onTestFailed } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { reloadConfiguration } from '@/configuration';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import { disableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { addServerProfile } from '@/server/serverProfiles';
import { applyEphemeralServerSelectionFromPrefixArgs } from '@/server/serverSelection';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { McpCommandDeps } from './deps';
import { runMcpServeCommand } from './serve';

// Transform the real MCP composition before the target-pinning workload's deadline.
await import('@/mcp/createExternalMcpServer');

type ObservedDaemonRequest = Readonly<{ path: string; controlToken: string | null }>;

const pluginTool = {
  toolId: 'acme.review.plugin/review-tool',
  actionId: formatQualifiedPluginActionId({ pluginId: 'acme.review.plugin', localId: 'review-start' }),
  name: 'acme_review_start',
  title: 'Acme Review Start',
  description: 'Start a review',
  inputSchema: {
    type: 'object' as const,
    properties: { scope: { type: 'string' as const } },
    required: ['scope'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object' as const,
    properties: { daemon: { type: 'string' as const } },
    required: ['daemon'],
    additionalProperties: false,
  },
  surfaces: ['mcp' as const],
  toolExposure: { mcp: 'direct' as const },
};

const pluginActionSpec = ActionDefinitionV1Schema.parse({
  id: pluginTool.actionId, title: pluginTool.title, description: null, safety: 'safe', executionPlacement: 'machine',
  placements: [], slash: null, bindings: null, examples: null, inputHints: null,
  surfaces: { agent: false, mcp: true, cli: false },
  inputSchema: pluginTool.inputSchema,
});

async function startDaemonControlServer(
  daemonName: string,
  observed: ObservedDaemonRequest[],
): Promise<Readonly<{ port: number; close: () => Promise<void> }>> {
  const server: Server = createServer((request, response) => {
    observed.push({
      path: request.url ?? '',
      controlToken: typeof request.headers['x-happier-daemon-token'] === 'string'
        ? request.headers['x-happier-daemon-token']
        : null,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/plugins/catalog/read') {
      response.end(JSON.stringify({ kind: 'available', plugins: [], tools: [pluginTool] }));
      return;
    }
    if (request.url === '/plugins/actions/execute') {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const { actionId } = JSON.parse(body) as { actionId?: string };
        // Placement admission reads the semantic descriptor from this same daemon before the effect.
        response.end(JSON.stringify({
          matched: true,
          result: { ok: true, result: actionId === 'action.spec.get'
            ? { actionSpec: pluginActionSpec } : { daemon: daemonName } },
        }));
      })();
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP daemon test server');
  return {
    port: address.port,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('happier mcp serve daemon target pinning', () => {
  const originalEnv = process.env;

  afterEach(() => {
    disableMcpStdioConsolePatch();
    process.env = originalEnv;
    reloadConfiguration();
  });

  it('ignores a conflicting ambient lifecycle scope for explicit-Home plugin catalog and execution', async () => {
    await withTempDir('happier-mcp-daemon-pinning-', async (homeDir) => {
      const selectedRequests: ObservedDaemonRequest[] = [];
      const attackerRequests: ObservedDaemonRequest[] = [];
      const startedAtMs = Date.now();
      let phase = 'start-selected-daemon';
      const phaseTimings = [{ phase, elapsedMs: 0 }];
      const enterPhase = (nextPhase: string) => {
        phase = nextPhase;
        phaseTimings.push({ phase, elapsedMs: Date.now() - startedAtMs });
      };
      onTestFailed(() => {
        console.error('MCP daemon pinning boundary', {
          phase,
          elapsedMs: Date.now() - startedAtMs,
          phaseTimings,
          selectedPaths: selectedRequests.map(({ path }) => path),
          attackerPaths: attackerRequests.map(({ path }) => path),
        });
      });
      const selectedDaemon = await startDaemonControlServer('selected', selectedRequests);
      enterPhase('start-attacker-daemon');
      const attackerDaemon = await startDaemonControlServer('attacker', attackerRequests);
      process.env = {
        ...originalEnv,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
      };
      delete process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID;
      reloadConfiguration();

      enterPhase('save-selected-profile');
      const selectedProfile = await addServerProfile({
        name: 'selected-home',
        serverUrl: 'https://selected-home.example.test',
        webappUrl: 'https://app.selected-home.example.test',
        use: false,
      });
      enterPhase('save-attacker-profile');
      const attackerProfile = await addServerProfile({
        name: 'attacker-home',
        serverUrl: 'https://attacker-home.example.test',
        webappUrl: 'https://app.attacker-home.example.test',
        use: false,
      });
      enterPhase('resolve-explicit-home');
      const resolution = await applyEphemeralServerSelectionFromPrefixArgs([
        '--server',
        selectedProfile.id,
        'mcp',
        'serve',
      ]);
      if (!resolution.selection) throw new Error('Expected an explicit saved Home selection');

      const daemonState = (port: number, controlToken: string) => ({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: '0.0.0-test',
        controlToken,
      });
      enterPhase('create-daemon-directories');
      await Promise.all([
        mkdir(join(homeDir, 'servers', selectedProfile.id), { recursive: true }),
        mkdir(join(homeDir, 'servers', attackerProfile.id), { recursive: true }),
      ]);
      enterPhase('write-daemon-states');
      await Promise.all([
        writeFile(
          join(homeDir, 'servers', selectedProfile.id, 'daemon.state.json'),
          JSON.stringify(daemonState(selectedDaemon.port, 'selected-control-token')),
          'utf8',
        ),
        writeFile(
          join(homeDir, 'servers', attackerProfile.id, 'daemon.state.json'),
          JSON.stringify(daemonState(attackerDaemon.port, 'attacker-control-token')),
          'utf8',
        ),
      ]);
      enterPhase('read-original-settings');
      const persistedBefore = await readFile(join(homeDir, 'settings.json'), 'utf8');

      process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID = attackerProfile.id;
      reloadConfiguration();

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'daemon-target-pinning-test', version: '1.0.0' }, { capabilities: {} });
      // Plugin execution re-reads the Home's stored credential to prove the served one is
      // still current, so the credential lives at the persistence boundary and is served from it.
      await writeStoredCredentialsForServerId(selectedProfile.id, {
        token: 'selected-home-token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      });
      const credentials = await readStoredCredentialsForServerId(selectedProfile.id);
      if (!credentials) throw new Error('Expected the selected Home credential');
      const deps: McpCommandDeps = {
        readStoredCredentials: async () => credentials,
        ensureMachineIdForCredentials: async () => ({ machineId: 'machine-selected' }),
        bootstrapAccountSettingsContext: async () => ({ settings: { actionsSettingsV1: null } }) as never,
        readDaemonPluginCatalog,
        resolveLiveDaemonControlTargetForServer,
        connectMcpStdio: async (mcp) => {
          enterPhase('connect-selected-server-transport');
          await mcp.connect(serverTransport);
          enterPhase('selected-server-transport-connected');
        },
      };

      try {
        enterPhase('serve-selected-home');
        await runMcpServeCommand(['serve'], deps, resolution.selection);
        enterPhase('connect-selected-client');
        await client.connect(clientTransport);
        enterPhase('invoke-selected-plugin');
        const result = CallToolResultSchema.parse(await client.callTool({
          name: 'acme_review_start',
          arguments: { scope: 'diff' },
        }));
        const textResult = result.content.find((item) => item.type === 'text');
        if (!textResult || textResult.type !== 'text') throw new Error('Expected the plugin Action JSON result');
        expect(result.isError, textResult.text).not.toBe(true);
        expect(result.structuredContent).toEqual({ daemon: 'selected' });
        expect(selectedRequests.map(({ path }) => path)).toEqual([
          '/plugins/catalog/read',
          '/plugins/actions/execute',
          '/plugins/actions/execute',
        ]);
        expect(attackerRequests).toEqual([]);
        expect(selectedRequests.every(({ controlToken }) => controlToken === 'selected-control-token')).toBe(true);
        enterPhase('verify-selected-settings');
        expect(await readFile(join(homeDir, 'settings.json'), 'utf8')).toBe(persistedBefore);

        enterPhase('close-selected-client');
        await client.close();
        enterPhase('remove-selected-daemon-state');
        await unlink(join(homeDir, 'servers', selectedProfile.id, 'daemon.state.json'));
        selectedRequests.length = 0;
        attackerRequests.length = 0;

        const [failClosedClientTransport, failClosedServerTransport] = InMemoryTransport.createLinkedPair();
        const failClosedClient = new Client(
          { name: 'daemon-target-fail-closed-test', version: '1.0.0' },
          { capabilities: {} },
        );
        try {
          enterPhase('serve-without-selected-daemon');
          await runMcpServeCommand(['serve'], {
            ...deps,
            connectMcpStdio: async (mcp) => {
              enterPhase('connect-fail-closed-server-transport');
              await mcp.connect(failClosedServerTransport);
              enterPhase('fail-closed-server-transport-connected');
            },
          }, resolution.selection);
          enterPhase('connect-fail-closed-client');
          await failClosedClient.connect(failClosedClientTransport);
          enterPhase('list-fail-closed-tools');
          const listed = await failClosedClient.listTools();
          expect(listed.tools.some(({ name }) => name === pluginTool.name)).toBe(false);
          expect(selectedRequests).toEqual([]);
          expect(attackerRequests).toEqual([]);
          enterPhase('verify-fail-closed-settings');
          expect(await readFile(join(homeDir, 'settings.json'), 'utf8')).toBe(persistedBefore);
        } finally {
          enterPhase('close-fail-closed-client');
          await failClosedClient.close();
        }
      } finally {
        enterPhase('close-selected-client-final');
        await client.close();
        enterPhase('close-selected-daemon');
        await selectedDaemon.close();
        enterPhase('close-attacker-daemon');
        await attackerDaemon.close();
      }
      enterPhase('complete');
    });
  });
});
