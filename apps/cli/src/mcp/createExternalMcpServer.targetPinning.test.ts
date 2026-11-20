import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';

import { configuration, reloadConfiguration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import * as daemonHttp from '@/daemon/controlHttp';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createExternalMcpServer } from './createExternalMcpServer';

type ObservedRequest = Readonly<{
  method: string;
  path: string;
  authorization: string | null;
}>;

async function startActionServer(observed: ObservedRequest[]): Promise<Readonly<{
  endpoint: string;
  close: () => Promise<void>;
}>> {
  const server: Server = createServer((request, response) => {
    observed.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: readAuthorization(request),
    });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/machines') {
      response.end(JSON.stringify([{
        id: 'machine-selected',
        active: true,
        revokedAt: null,
        replacedByMachineId: null,
      }]));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/actions/session.list') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        const parsed = JSON.parse(body) as Readonly<{ requestId?: unknown }>;
        response.end(JSON.stringify({
          v: 1,
          actionId: 'session.list',
          ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
          execution: {
            ok: true,
            result: { sessions: [], nextCursor: null, hasNext: false },
          },
        }));
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP test server');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readAuthorization(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return typeof value === 'string' ? value : null;
}

describe('createExternalMcpServer target pinning', () => {
  const originalEnv = process.env;

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    reloadConfiguration();
  });

  it('executes authored Account Actions through the public MCP tool on its captured Home without a Machine', async () => {
    await withTempDir('happier-mcp-account-target-', async homeDir => {
      const app = fastify();
      const selectedRequests: ObservedRequest[] = [];
      const attackerRequests: ObservedRequest[] = [];
      const accountId = 'mcp-account-owner';
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
      app.addHook('onRequest', async request => {
        selectedRequests.push({ method: request.method, path: request.url,
          authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : null });
      });
      const { pluginId } = await registerAuthoredAccountActionRelease(app, accountId);
      const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_mcp_account_selected' });
      app.get('/v1/features/authenticated', async () => features);
      const stored = PluginAccountStorageReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, values: { sample: { version: 1, value: 'selected Account value' } } } } });
      app.get(`/v1/account/plugin-storage/${pluginId}`, async () => stored);
      const endpoint = await app.listen({ port: 0, host: '127.0.0.1' });
      const attacker = await startActionServer(attackerRequests);
      process.env = { ...originalEnv, HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint,
        HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({ v: 1, actions: { 'action.invoke': { enabled: true } } }) };
      reloadConfiguration();
      const capturedServerId = configuration.activeServerId;
      await writeStoredCredentialsForServerId(capturedServerId, credentials);
      // Daemon HTTP remains a genuine system boundary. The MCP bridge, host
      // admission, authored artifact and Account storage adapters stay real.
      const daemonPost = vi.spyOn(daemonHttp, 'daemonPost').mockRejectedValue(new Error('Unexpected Machine execution'));
      const { mcp } = createExternalMcpServer({ credentials, daemonControlTarget: null,
        serverFeaturesSnapshot: { status: 'ready', provenance: 'authenticated', features } });
      process.env.HAPPIER_SERVER_URL = attacker.endpoint;
      process.env.HAPPIER_WEBAPP_URL = attacker.endpoint;
      reloadConfiguration();
      const client = new Client({ name: 'account-action-mcp-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const invoke = async (localId: string) => CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'action.invoke', input: { action: { pluginId, localId }, input: { key: 'sample' } } } }));
      const resultValue = (result: ReturnType<typeof CallToolResultSchema.parse>) => {
        const content = result.content.find(entry => entry.type === 'text');
        if (content?.type !== 'text') throw new Error('Missing MCP Action result');
        return JSON.parse(content.text) as unknown;
      };
      try {
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        const echoed = await invoke('echo');
        expect(echoed.isError, JSON.stringify(echoed)).not.toBe(true);
        expect(resultValue(echoed)).toEqual({ key: 'sample', surface: 'mcp' });
        const read = await invoke('read');
        expect(read.isError, JSON.stringify(read)).not.toBe(true);
        expect(resultValue(read)).toEqual({ value: 'selected Account value' });
        expect(selectedRequests).toContainEqual(expect.objectContaining({ path: `/v1/account/plugin-storage/${pluginId}` }));
        expect(selectedRequests.every(request => request.authorization === `Bearer ${credentials.token}`)).toBe(true);
        await writeStoredCredentialsForServerId(capturedServerId, { ...credentials,
          token: `header.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature` });
        // This host retains its captured credentials; replacing the saved login
        // affects a later host, while this invocation keeps its original Account.
        const requestsBeforeReplacementRead = selectedRequests.length;
        const readAfterReplacement = await invoke('read');
        expect(readAfterReplacement.isError, JSON.stringify(readAfterReplacement)).not.toBe(true);
        expect(resultValue(readAfterReplacement)).toEqual({ value: 'selected Account value' });
        expect(selectedRequests.slice(requestsBeforeReplacementRead)).toContainEqual(expect.objectContaining({
          path: `/v1/account/plugin-storage/${pluginId}`, authorization: `Bearer ${credentials.token}`,
        }));
        expect(selectedRequests.every(request => request.authorization === `Bearer ${credentials.token}`)).toBe(true);
        expect(attackerRequests).toEqual([]);
        expect(daemonPost).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await mcp.close();
        await app.close();
        await attacker.close();
      }
    });
  });

  it('keeps post-construction PAT actions on the selected Home after global configuration changes', async () => {
    await withTempDir('happier-mcp-target-pinning-', async (homeDir) => {
      const selectedRequests: ObservedRequest[] = [];
      const attackerRequests: ObservedRequest[] = [];
      const selected = await startActionServer(selectedRequests);
      const attacker = await startActionServer(attackerRequests);
      process.env = {
        ...originalEnv,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: selected.endpoint,
        HAPPIER_WEBAPP_URL: selected.endpoint,
      };
      reloadConfiguration();

      const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
      const { mcp } = createExternalMcpServer({
        credentials: {
          token,
          encryption: null,
          credentialProvenance: 'api_token',
        },
        defaultSessionId: 'c123456789012345678901234',
      });

      process.env.HAPPIER_SERVER_URL = attacker.endpoint;
      process.env.HAPPIER_WEBAPP_URL = attacker.endpoint;
      reloadConfiguration();

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'target-pinning-test', version: '1.0.0' }, { capabilities: {} });
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: 'action_execute', arguments: {
          actionId: 'session.list', input: { limit: 1 },
        } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(selectedRequests).toEqual(expect.arrayContaining([
          expect.objectContaining({
            method: 'POST',
            path: '/v1/actions/session.list',
            authorization: `Bearer ${token}`,
          }),
        ]));
        expect(selectedRequests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
        expect(attackerRequests).toEqual([]);
        await expect(readFile(`${homeDir}/settings.json`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await client.close();
        await mcp.close();
        await selected.close();
        await attacker.close();
      }
    });
  });
});
