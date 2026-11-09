import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { configuration } from '@/configuration';
import { readStoredCredentialsForServerId, removeStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createExternalMcpServer } from './createExternalMcpServer';

describe('MCP captured session credentials', () => {
  it('keeps external Account custody without per-call credential reads after file replacement', async () => {
    const serverId = configuration.activeServerId;
    const previous = await readStoredCredentialsForServerId(serverId);
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'captured-mcp-account' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    await writeStoredCredentialsForServerId(serverId, credentials);
    const app = fastify();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://captured-mcp.test' });
    const snapshot = { status: 'ready' as const, provenance: 'authenticated' as const,
      features: FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, following: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: 'srv_captured_mcp' } } }) };
    const receiver = { kind: 'account' as const };
    const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [serverId] }),
      policy: { preset: 'important' as const } };
    let revoked = false;
    let requests = 0;
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v2/account/session-follow-rules/:ruleId', async (request, reply) => {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
      requests += 1;
      return revoked ? reply.code(401).send({ error: 'not_authenticated' })
        : { rule: { ruleId: 'captured-rule', receiver, content: { t: 'plain', v: definition }, version: 1 } };
    });
    const fileReads = vi.spyOn(fs, 'readFile');
    const runtime = runWithServerHttpBaseUrl('http://captured-mcp.test', () =>
      createExternalMcpServer({ credentials, serverFeaturesSnapshot: snapshot }));
    const client = new Client({ name: 'captured-mcp-contract', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const read = async () => CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'follow.get', input: { receiver, source: { kind: 'rule', ruleId: 'captured-rule' } },
    } }));
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const initial = await read();
      expect(initial.isError, JSON.stringify(initial)).toBe(false);
      const accessKeyReads = () => fileReads.mock.calls.filter(([path]) => String(path) === join(configuration.serversDir, serverId, 'access.key'));
      expect(accessKeyReads()).toHaveLength(0);
      await writeStoredCredentialsForServerId(serverId, { ...credentials,
        token: `header.${Buffer.from(JSON.stringify({ sub: 'replacement-mcp-account' })).toString('base64url')}.signature` });
      const result = await read();
      expect(result.isError, JSON.stringify(result)).toBe(false);
      expect(accessKeyReads()).toHaveLength(0);
      expect(requests).toBe(2);
      revoked = true;
      expect((await read()).isError).toBe(true);
      expect(requests).toBe(3);
      expect(accessKeyReads()).toHaveLength(0);
    } finally {
      fileReads.mockRestore();
      await client.close(); await runtime.mcp.close(); restore(); await app.close();
      if (previous) await writeStoredCredentialsForServerId(serverId, previous);
      else await removeStoredCredentialsForServerId(serverId);
    }
  });
});
